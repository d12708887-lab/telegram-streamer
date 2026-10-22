/* Telegram -> HTML5 video streamer (Express + GramJS)
   GET /stream/:messageId    -> plays in <video> (supports seeking via HTTP Range)
   GET /download/:messageId  -> forces a file download
   GET /                     -> health check (use it for uptime pings)            */
const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const bigInt = require('big-integer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CustomFile } = require('telegram/client/uploads');

const API_ID = parseInt(process.env.API_ID, 10);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = String(process.env.CHANNEL_ID || ''); // e.g. -1001234567890
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const PORT = process.env.PORT || 3000;
const UPLOAD_KEY = process.env.UPLOAD_KEY || ''; // password for uploading from the admin panel (optional)
const MAX_UPLOAD = 2000 * 1024 * 1024; // 2 GB, Telegram's limit for bots

if (!API_ID || !API_HASH || !BOT_TOKEN || !CHANNEL_ID) {
  console.error('Missing env vars: API_ID, API_HASH, BOT_TOKEN, CHANNEL_ID');
  process.exit(1);
}

const CHUNK = 512 * 1024; // Telegram needs 4KB-aligned offsets; 512KB divides the 1MB window
let client = null;
let PEER = null;
let RAW = '';

async function startTelegram() {
  client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { connectionRetries: 10 });
  await client.start({ botAuthToken: BOT_TOKEN });
  const raw = CHANNEL_ID.replace(/^-100/, '').replace(/^-/, '');
  RAW = raw;
  PEER = new Api.InputPeerChannel({ channelId: bigInt(raw), accessHash: bigInt(0) });
  console.log('Telegram bot connected');
}

const cache = new Map(); // messageId -> { msg, t }
async function getMsg(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < 5 * 60 * 1000) return hit.msg;
  const r = await client.getMessages(PEER, { ids: [id] });
  const msg = r && r[0];
  if (msg) cache.set(id, { msg, t: Date.now() });
  return msg;
}

function fileName(doc, id) {
  const a = (doc.attributes || []).find((x) => x.fileName);
  return (a && a.fileName) || 'video-' + id + '.mp4';
}

async function serve(req, res, asDownload) {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).send('Bad message id');

  let msg;
  try { msg = await getMsg(id); }
  catch (e) { console.error('getMsg:', e.message); return res.status(502).send('Telegram error: ' + e.message); }

  const doc = msg && msg.media && msg.media.document;
  if (!doc) return res.status(404).send('No video/file in this message');

  const size = Number(doc.size);
  const mime = doc.mimeType || 'video/mp4';
  let start = 0, end = size - 1;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] !== '') start = parseInt(m[1], 10);
      if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
      if (m[1] === '' && m[2] !== '') { start = Math.max(size - parseInt(m[2], 10), 0); end = size - 1; }
    }
  }
  if (start > end || start >= size) {
    return res.status(416).set('Content-Range', 'bytes */' + size).end();
  }

  res.status(range ? 206 : 200);
  res.set({
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN
  });
  if (range) res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  if (asDownload) res.set('Content-Disposition', 'attachment; filename="' + fileName(doc, id).replace(/"/g, '') + '"');

  let closed = false;
  res.on('close', () => { closed = true; });

  const aligned = start - (start % CHUNK);
  let pos = aligned;
  try {
    for await (const chunk of client.iterDownload({
      file: msg.media, offset: bigInt(aligned), requestSize: CHUNK, fileSize: bigInt(size)
    })) {
      if (closed) break;
      const cs = pos, ce = pos + chunk.length - 1;
      pos += chunk.length;
      if (ce < start) continue;
      const part = chunk.subarray(Math.max(start, cs) - cs, Math.min(end, ce) - cs + 1);
      if (!res.write(part)) await new Promise((r) => res.once('drain', r));
      if (ce >= end) break;
    }
  } catch (e) { console.error('stream error:', e.message); }
  res.end();
}

const app = express();
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'X-Upload-Key, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
function checkKey(req, res) {
  if (!UPLOAD_KEY) { res.status(503).json({ error: 'UPLOAD_KEY is not set on the server' }); return false; }
  if (req.headers['x-upload-key'] !== UPLOAD_KEY) { res.status(401).json({ error: 'Wrong upload password' }); return false; }
  return true;
}
app.get('/check', (req, res) => { if (checkKey(req, res)) res.json({ ok: true }); });

// Admin panel sends the video file here; we pass it to the Telegram channel and return the message id.
app.post('/upload', (req, res) => {
  if (!checkKey(req, res)) return;
  const len = parseInt(req.headers['content-length'] || '0', 10);
  if (len > MAX_UPLOAD) return res.status(413).json({ error: 'File is bigger than 2 GB' });
  let name = String(req.query.name || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'video.mp4';
  const tmp = path.join(os.tmpdir(), 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2) + path.extname(name));
  const ws = fs.createWriteStream(tmp);
  let failed = false;
  const clean = () => fs.unlink(tmp, () => {});
  req.pipe(ws);
  req.on('aborted', () => { failed = true; ws.destroy(); clean(); });
  ws.on('error', (e) => { failed = true; clean(); if (!res.headersSent) res.status(500).json({ error: 'Disk error: ' + e.message }); });
  ws.on('finish', async () => {
    if (failed) return;
    try {
      const size = fs.statSync(tmp).size;
      if (!size) throw new Error('Empty file');
      let target = PEER;
      try { target = await client.getInputEntity(new Api.PeerChannel({ channelId: bigInt(RAW) })); } catch (e) { target = PEER; }
      const msg = await client.sendFile(target, {
        file: new CustomFile(name, size, tmp),
        forceDocument: true,
        caption: name,
        workers: 1
      });
      clean();
      res.json({ id: msg.id });
    } catch (e) {
      clean();
      console.error('upload error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });
});
/* ---------- Big-file upload in small pieces (resumable): used by the admin panel ----------
   POST /upload/start?name=&size=   -> { uid }
   POST /upload/chunk?uid=&offset=  (raw bytes, up to 16 MB) -> { received }
   POST /upload/finish?uid=         -> starts sending the file to Telegram (answers at once)
   GET  /upload/status?uid=         -> { state: uploading | sending | done | error, progress, id }       */
const uploads = new Map(); // uid -> { name, size, tmp, received, state, progress, id, error, t }
function cleanName(n) { return String(n || 'video.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'video.mp4'; }
setInterval(() => {
  const now = Date.now();
  for (const [uid, u] of uploads) {
    if (u.state !== 'sending' && now - u.t > 6 * 3600 * 1000) { fs.unlink(u.tmp, () => {}); uploads.delete(uid); }
  }
}, 10 * 60 * 1000).unref();

function upStart(req, res) {
  if (!checkKey(req, res)) return;
  const size = parseInt(req.query.size, 10);
  if (!size || size < 1) return res.status(400).json({ error: 'Missing file size' });
  if (size > MAX_UPLOAD) return res.status(413).json({ error: 'File is bigger than 2000 MB (Telegram limit for bots)' });
  let active = 0;
  for (const u of uploads.values()) if (u.state === 'uploading' || u.state === 'sending') active++;
  if (active >= 2) return res.status(429).json({ error: 'Two uploads are already running. Wait for one to finish.' });
  const name = cleanName(req.query.name);
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const tmp = path.join(os.tmpdir(), 'up-' + uid + path.extname(name));
  try { fs.closeSync(fs.openSync(tmp, 'w')); }
  catch (e) { return res.status(500).json({ error: 'Disk error: ' + e.message }); }
  uploads.set(uid, { name, size, tmp, received: 0, state: 'uploading', progress: 0, t: Date.now() });
  res.json({ uid });
}
function upChunk(req, res) {
  if (!checkKey(req, res)) return;
  const u = uploads.get(String(req.query.uid || ''));
  if (!u || u.state !== 'uploading') return res.status(404).json({ error: 'Upload not found (the server may have restarted). Start the upload again.' });
  const offset = parseInt(req.query.offset, 10);
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ error: 'Empty piece' });
  if (isNaN(offset) || offset < 0 || offset > u.received) return res.status(409).json({ error: 'Piece out of order', received: u.received });
  if (offset + body.length > u.size) return res.status(400).json({ error: 'Piece goes past the end of the file' });
  fs.open(u.tmp, 'r+', (e, fd) => {
    if (e) return res.status(500).json({ error: 'Disk error: ' + e.message });
    fs.write(fd, body, 0, body.length, offset, (e2) => {
      fs.close(fd, () => {});
      if (e2) return res.status(500).json({ error: 'Disk error: ' + e2.message });
      u.received = Math.max(u.received, offset + body.length);
      u.t = Date.now();
      res.json({ received: u.received });
    });
  });
}
async function sendToTelegram(u) {
  try {
    let target = PEER;
    try { target = await client.getInputEntity(new Api.PeerChannel({ channelId: bigInt(RAW) })); } catch (e) { target = PEER; }
    const msg = await client.sendFile(target, {
      file: new CustomFile(u.name, u.size, u.tmp),
      forceDocument: true,
      caption: u.name,
      workers: 1,
      progressCallback: (p) => { if (typeof p === 'number') u.progress = p; }
    });
    u.id = msg.id; u.progress = 1; u.state = 'done';
  } catch (e) {
    console.error('upload error:', e.message);
    u.error = e.message; u.state = 'error';
  }
  u.t = Date.now();
  fs.unlink(u.tmp, () => {});
}
function upFinish(req, res) {
  if (!checkKey(req, res)) return;
  const u = uploads.get(String(req.query.uid || ''));
  if (!u) return res.status(404).json({ error: 'Upload not found (the server may have restarted). Start the upload again.' });
  if (u.state === 'sending' || u.state === 'done') return res.status(202).json({ state: u.state });
  if (u.state === 'error') return res.status(500).json({ error: u.error || 'Upload failed' });
  if (u.received !== u.size) return res.status(409).json({ error: 'Not all pieces arrived', received: u.received });
  u.state = 'sending'; u.progress = 0; u.t = Date.now();
  res.status(202).json({ state: 'sending' });
  sendToTelegram(u);
}
function upStatus(req, res) {
  if (!checkKey(req, res)) return;
  const u = uploads.get(String(req.query.uid || ''));
  if (!u) return res.status(404).json({ error: 'Upload not found (the server may have restarted). Start the upload again.' });
  res.json({ state: u.state, received: u.received, size: u.size, progress: u.progress, id: u.id, error: u.error });
}
app.post('/upload/start', upStart);
app.post('/upload/chunk', express.raw({ type: () => true, limit: '20mb' }), upChunk);
app.post('/upload/finish', upFinish);
app.get('/upload/status', upStatus);

app.get('/', (req, res) => res.send('Streamer is running'));
app.get('/stream/:id', (req, res) => serve(req, res, false));
app.get('/download/:id', (req, res) => serve(req, res, true));

startTelegram()
  .then(() => {
    const server = app.listen(PORT, () => console.log('Listening on ' + PORT));
    server.requestTimeout = 0; server.timeout = 0; server.headersTimeout = 65000; // allow long uploads
  })
  .catch((e) => { console.error('Startup failed:', e); process.exit(1); });
