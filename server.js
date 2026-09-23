require('dotenv').config({ quiet: true });
const os = require('os');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const { loadTribes } = require('./lib/tribes');
const { classify, MODEL, MULTI_MATCH } = require('./lib/classify');
const { fetchSeriesImages } = require('./lib/exactitudes');
const { composite, CREDIT } = require('./lib/composite');
const results = require('./lib/results');
const { AppError } = require('./lib/errors');

const PORT = Number(process.env.PORT) || 3000;
const RESULTS_PORT = Number(process.env.RESULTS_PORT) || PORT + 1;
// The kiosk (camera page + Gemini-backed API) only listens on this machine by default.
const KIOSK_HOST = process.env.KIOSK_HOST || '127.0.0.1';
const COUNTDOWN_SECONDS = Number(process.env.COUNTDOWN_SECONDS) || 3;
const DWELL_MS = Number(process.env.DWELL_MS) || 1200;
const VOICE_LANG = process.env.VOICE_LANG || 'en-US';

let publicBase = null; // where a visitor's phone reaches the results server

function lanAddress() {
  const ifaces = os.networkInterfaces();
  const order = ['en0', 'en1', 'eth0', 'wlan0', ...Object.keys(ifaces)];
  for (const name of order) {
    const hit = (ifaces[name] || []).find((a) => a.family === 'IPv4' && !a.internal);
    if (hit) return hit.address;
  }
  return 'localhost';
}

// ?w=&h= is the viewing screen's size in CSS px; only its shape matters.
function viewportFrom(q) {
  const w = Math.round(Number(q.w));
  const h = Math.round(Number(q.h));
  if (!(w >= 200 && w <= 8000 && h >= 200 && h <= 8000)) return null;
  return { w, h };
}

function sendResult(req, res) {
  results.get(req.params.id, viewportFrom(req.query)).then((png) => {
    if (!png) return res.status(404).type('text/plain').send('This result has expired or never existed.');
    res.set({
      'Content-Type': 'image/png',
      'Content-Disposition': 'inline; filename="exactitudes-mirror.png"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    res.send(png);
  });
}

// What the QR code opens: a bare page that asks for a PNG in this screen's
// exact shape and shows it edge to edge. Re-requests on rotation.
function sendViewer(req, res) {
  if (!results.exists(req.params.id)) {
    return res.status(404).type('text/plain').send('This result has expired or never existed.');
  }
  const png = `/results/${encodeURIComponent(req.params.id)}.png`;
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Your Exactitudes Mirror result</title>
<style>
  html, body { margin: 0; height: 100%; background: #fdf8e8; overflow: hidden; }
  img { position: fixed; inset: 0; width: 100vw; height: 100vh; height: 100dvh; object-fit: cover; display: block; }
  a { position: fixed; right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); padding: 10px 16px;
      border-radius: 999px; background: rgba(17,17,17,.82); color: #fff; font: 15px/1 Arial, Helvetica, sans-serif;
      text-decoration: none; }
</style></head>
<body>
<img id="r" alt="Your Exactitudes Mirror result">
<a id="save" download="exactitudes-mirror.png">Save image</a>
<script>
  var img = document.getElementById('r'), save = document.getElementById('save'), last = '';
  function load() {
    var w = window.innerWidth, h = window.innerHeight, src = '${png}?w=' + w + '&h=' + h;
    if ((w / h).toFixed(2) === last) return;
    last = (w / h).toFixed(2);
    img.src = src; save.href = src;
  }
  var t; window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(load, 250); });
  load();
</script>
</body></html>`);
}

// ---------- Kiosk app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/mediapipe', express.static(path.join(__dirname, 'node_modules/@mediapipe/tasks-vision')));

app.get('/api/config', (req, res) => {
  res.json({
    countdownSeconds: COUNTDOWN_SECONDS,
    dwellMs: DWELL_MS,
    voiceLang: VOICE_LANG,
    multiMatch: MULTI_MATCH,
    resultTtlMinutes: results.TTL_MS / 60000,
    // Titles only, used to animate the loading screen with real tribe names.
    tribeNames: loadTribes().map((t) => t.title.replace(/^\d+\.\s*/, '')),
  });
});

app.post('/api/match', async (req, res) => {
  const started = Date.now();
  try {
    const { image, viewport } = req.body || {};
    if (typeof image !== 'string' || image.length < 1000) {
      throw new AppError('BAD_REQUEST', 'No photo received', 400);
    }
    const jpegBase64 = image.replace(/^data:image\/\w+;base64,/, '');

    const matches = await classify(jpegBase64);
    const visitorJpeg = Buffer.from(jpegBase64, 'base64');

    const out = await Promise.all(
      matches.map(async (m) => {
        const images = await fetchSeriesImages(m.tribe.id);
        // Somewhere among the archive portraits, not first or last.
        const visitorIndex = 1 + Math.floor(Math.random() * Math.max(1, images.length - 1));
        const match = { ...m, images, visitorIndex };
        const id = results.create((v) => composite(match, visitorJpeg, v), viewport || { w: 1080, h: 1920 });
        const resultUrl = `${publicBase}/results/${id}`;
        const qrSvg = await QRCode.toString(resultUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        return {
          title: m.tribe.title,
          location: m.tribe.location,
          year: m.tribe.year,
          link: m.tribe.link,
          styleDescription: m.styleDescription,
          caption: m.caption,
          images,
          visitorIndex,
          resultUrl,
          qrSvg,
        };
      })
    );

    console.log(`[match] ${out.map((m) => m.title).join(' / ')} (${out[0].images.length} photos) in ${Date.now() - started}ms`);
    res.json({ matches: out, credit: CREDIT });
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError('INTERNAL', err.message, 500);
    console.error(`[match] ${e.code}: ${e.message}`);
    res.status(e.status).json({ error: { code: e.code } });
  }
});

app.get('/results/:id.png', sendResult);
app.get('/results/:id', sendViewer);

// ---------- Results-only app (reachable from visitors' phones) ----------
const share = express();
share.disable('x-powered-by');
share.get('/results/:id.png', sendResult);
share.get('/results/:id', sendViewer);
share.use((req, res) => res.status(404).type('text/plain').send('Not found'));

async function start() {
  const tribes = loadTribes(); // fail fast if the seed hasn't been run
  if (!process.env.GEMINI_API_KEY) console.warn('! GEMINI_API_KEY is not set; matching will fail.');

  await new Promise((r) => app.listen(PORT, KIOSK_HOST, r));
  await new Promise((r) => share.listen(RESULTS_PORT, '0.0.0.0', r));

  if (String(process.env.USE_NGROK).toLowerCase() === 'true') {
    const ngrok = require('@ngrok/ngrok');
    const listener = await ngrok.forward({
      addr: RESULTS_PORT,
      authtoken: process.env.NGROK_AUTHTOKEN,
      ...(process.env.NGROK_DOMAIN ? { domain: process.env.NGROK_DOMAIN } : {}),
    });
    publicBase = listener.url();
  } else {
    publicBase = `http://${process.env.PUBLIC_HOST || lanAddress()}:${RESULTS_PORT}`;
  }

  console.log(`Exactitudes Mirror
  Kiosk:    http://${KIOSK_HOST === '0.0.0.0' ? 'localhost' : KIOSK_HOST}:${PORT}
  QR base:  ${publicBase}   (results only, check it from a real phone)
  Model:    ${MODEL}${MULTI_MATCH ? '  [multi-match on]' : ''}
  Tribes:   ${tribes.length} from data/tribes.json
  Result TTL: ${results.TTL_MS / 60000} min`);
}

start().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
