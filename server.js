require('dotenv').config({ quiet: true });
const os = require('os');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const { loadTribes } = require('./lib/tribes');
const { classify, MODEL, MULTI_MATCH } = require('./lib/classify');
const { fetchSeriesImages } = require('./lib/exactitudes');
const { composite, CREDIT } = require('./lib/composite');
const cutouts = require('./lib/cutouts');
const results = require('./lib/results');
const { AppError } = require('./lib/errors');

const PORT = Number(process.env.PORT) || 3000;
const RESULTS_PORT = Number(process.env.RESULTS_PORT) || PORT + 1;
// The kiosk page and the Gemini-backed API only listen on this machine.
const KIOSK_HOST = process.env.KIOSK_HOST || '127.0.0.1';
const CUTOUT_WAIT_MS = 15000; // measured from the match request; the AI call usually takes ~7s

const CAPTURE_ID = /^[0-9a-f-]{36}$/i;
let publicBase = null; // where a visitor's phone reaches the results server

function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of ['en0', 'en1', 'eth0', 'wlan0', ...Object.keys(ifaces)]) {
    const hit = (ifaces[name] || []).find((a) => a.family === 'IPv4' && !a.internal);
    if (hit) return hit.address;
  }
  return 'localhost';
}

function jpegFrom(body) {
  const image = body && body.image;
  if (typeof image !== 'string' || image.length < 1000) throw new AppError('BAD_REQUEST', 'No photo received', 400);
  return image.replace(/^data:image\/\w+;base64,/, '');
}

function captureIdFrom(body) {
  const id = body && body.captureId;
  if (typeof id !== 'string' || !CAPTURE_ID.test(id)) throw new AppError('BAD_REQUEST', 'Missing captureId', 400);
  return id;
}

function viewportFrom(v) {
  const w = Math.round(Number(v && v.w));
  const h = Math.round(Number(v && v.h));
  return w >= 200 && w <= 8000 && h >= 200 && h <= 8000 ? { w, h } : null;
}

function fail(res, err) {
  const e = err instanceof AppError ? err : new AppError('INTERNAL', err.message, 500);
  console.error(`[error] ${e.code}: ${e.message}`);
  res.status(e.status).json({ error: { code: e.code } });
}

// ---------- shared result routes ----------
const expired = (res) => res.status(404).type('text/plain').send('This result has expired or never existed.');

async function sendPng(req, res) {
  const png = await results.get(req.params.id, viewportFrom(req.query));
  if (!png) return expired(res);
  res.set({
    'Content-Type': 'image/png',
    'Content-Disposition': `${req.query.dl ? 'attachment' : 'inline'}; filename="exactitudes-mirror.png"`,
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  });
  res.send(png);
}

// What the QR code opens: a bare page that asks for the PNG in this screen's
// exact shape, shows it edge to edge, and re-requests it on rotation.
function sendViewer(req, res) {
  if (!results.exists(req.params.id)) return expired(res);
  const png = `/results/${encodeURIComponent(req.params.id)}.png`;
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Your Exactitudes Mirror</title>
<style>
  html, body { margin: 0; height: 100%; background: #F3F3F3; overflow: hidden; }
  img { position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh; object-fit: cover; display: block; }
  a { position: fixed; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); padding: 12px 18px;
      border-radius: 999px; background: rgba(17,17,17,.85); color: #fff; font: 16px/1 Arial, Helvetica, sans-serif;
      text-decoration: none; }
</style></head>
<body>
<img id="r" alt="Your Exactitudes Mirror result">
<a id="save" download="exactitudes-mirror.png">Save image</a>
<script>
  var img = document.getElementById('r'), save = document.getElementById('save'), last = '';
  function load() {
    var w = innerWidth, h = innerHeight, shape = (w / h).toFixed(2);
    if (shape === last) return;
    last = shape;
    img.src = '${png}?w=' + w + '&h=' + h;
    save.href = img.src + '&dl=1';
  }
  var t; addEventListener('resize', function () { clearTimeout(t); t = setTimeout(load, 250); });
  load();
</script>
</body></html>`);
}

// ---------- kiosk app (this machine only) ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/mediapipe', express.static(path.join(__dirname, 'node_modules/@mediapipe/tasks-vision')));

app.get('/api/config', (req, res) => {
  res.json({
    countdownSeconds: Number(process.env.COUNTDOWN_SECONDS) || 3,
    dwellMs: Number(process.env.DWELL_MS) || 1200,
    voiceLang: process.env.VOICE_LANG || 'en-US',
    multiMatch: MULTI_MATCH,
    resultTtlMinutes: results.TTL_MS / 60000,
    // Titles only, to animate the loading screen with real tribe names.
    tribeNames: loadTribes().map((t) => t.title.replace(/^\d+\.\s*/, '')),
  });
});

// 1) The original photo: AI match + live series fetch.
app.post('/api/match', async (req, res) => {
  const started = Date.now();
  try {
    const captureId = captureIdFrom(req.body);
    const jpeg = jpegFrom(req.body);
    const original = Buffer.from(jpeg, 'base64');
    const viewport = viewportFrom(req.body.viewport) || { w: 1080, h: 1920 };

    // Collect the cut-out in parallel; fall back to the original if it never comes.
    const visitor = cutouts.take(captureId, CUTOUT_WAIT_MS).then((cut) => {
      console.log(`[cutout] ${cut ? `received ${Date.now() - started}ms after capture` : 'none, using the original photo'}`);
      return cut || { buf: original, box: null };
    });

    const matches = await classify(jpeg);
    const aiMs = Date.now() - started;

    const out = await Promise.all(
      matches.map(async (m) => {
        const images = await fetchSeriesImages(m.tribe.id);
        // Somewhere among the archive portraits, never first or last.
        const visitorIndex = 1 + Math.floor(Math.random() * Math.max(1, images.length - 1));
        const match = { ...m, images, visitorIndex };
        const id = results.create(async (v) => composite(match, await visitor, v), viewport);
        results.warm(id);
        const resultUrl = `${publicBase}/results/${id}`;
        return {
          title: m.tribe.title,
          location: m.tribe.location,
          year: m.tribe.year,
          styleDescription: m.styleDescription,
          caption: m.caption,
          images,
          visitorIndex,
          resultUrl,
          qrSvg: await QRCode.toString(resultUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
        };
      })
    );

    console.log(`[match] ${out.map((m) => m.title).join(' / ')} (${out[0].images.length} photos) · AI ${aiMs}ms · total ${Date.now() - started}ms`);
    res.json({ matches: out, credit: CREDIT });
  } catch (err) {
    fail(res, err);
  }
});

// 2) The background-removed cut-out, tagged with the same captureId.
app.post('/api/cutout', (req, res) => {
  try {
    const captureId = captureIdFrom(req.body);
    if (req.body.failed) {
      cutouts.put(captureId, null);
    } else {
      // box: the person's size as a fraction of the square, used so the grid never crops them.
      const b = req.body.box;
      const frac = (v) => typeof v === 'number' && v > 0 && v <= 1;
      const box = b && frac(b.w) && frac(b.h) ? { w: b.w, h: b.h } : null;
      cutouts.put(captureId, { buf: Buffer.from(jpegFrom(req.body), 'base64'), box });
    }
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
});

app.get('/results/:id.png', sendPng);
app.get('/results/:id', sendViewer);

// ---------- results-only app (reachable from visitors' phones) ----------
const share = express();
share.disable('x-powered-by');
share.get('/results/:id.png', sendPng);
share.get('/results/:id', sendViewer);
share.use((req, res) => res.status(404).type('text/plain').send('Not found'));

async function start() {
  const tribes = loadTribes(); // fail fast if the seed hasn't run
  if (!process.env.GEMINI_API_KEY) console.warn('! GEMINI_API_KEY is not set; matching will fail.');

  await new Promise((r) => app.listen(PORT, KIOSK_HOST, r));
  await new Promise((r) => share.listen(RESULTS_PORT, '0.0.0.0', r));

  if (String(process.env.USE_NGROK).toLowerCase() === 'true') {
    const ngrok = require('@ngrok/ngrok');
    const listener = await ngrok.forward({
      addr: RESULTS_PORT, // only the results server is tunnelled, never the API
      authtoken: process.env.NGROK_AUTHTOKEN,
      ...(process.env.NGROK_DOMAIN ? { domain: process.env.NGROK_DOMAIN } : {}),
    });
    publicBase = listener.url();
  } else {
    publicBase = `http://${process.env.PUBLIC_HOST || lanAddress()}:${RESULTS_PORT}`;
  }

  console.log(`Exactitudes Mirror V4
  Kiosk:      http://${KIOSK_HOST === '0.0.0.0' ? 'localhost' : KIOSK_HOST}:${PORT}
  QR base:    ${publicBase}   (results only; test it from a real phone)
  Model:      ${MODEL}${MULTI_MATCH ? '  [multi-match on]' : ''}
  Tribes:     ${tribes.length} from data/tribes.json (${tribes.filter((t) => t.dressCode).length} with dress-code descriptions)
  Result TTL: ${results.TTL_MS / 60000} min`);
}

start().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
