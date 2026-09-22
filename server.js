require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const sharp = require('sharp');
const QRCode = require('qrcode');
const ngrok = require('@ngrok/ngrok');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const EXACTITUDES_BASE = 'https://exactitudes.com/wp-json/custom-rest/v1';
const TRIBES_PATH = path.join(__dirname, 'data', 'tribes.json');
const RESULTS_DIR = path.join(__dirname, 'tmp', 'results');
const RESULT_TTL_MS = (Number(process.env.RESULT_TTL_MINUTES) || 20) * 60 * 1000;
const PORT = process.env.PORT || 3000;

fs.mkdirSync(RESULTS_DIR, { recursive: true });

// --- Tribe index: read once from local storage, never fetched live per-request. ---
// See scripts/seed-tribes.js. Re-run that by hand to pick up new archive series.
let tribes = null;
function loadTribes() {
  if (tribes) return tribes;
  if (!fs.existsSync(TRIBES_PATH)) {
    throw new Error(
      `${path.relative(__dirname, TRIBES_PATH)} not found. Run "npm run seed" first to fetch the tribe index from exactitudes.com.`
    );
  }
  tribes = JSON.parse(fs.readFileSync(TRIBES_PATH, 'utf8'));
  return tribes;
}

async function getSeriesImages(wpId) {
  const res = await fetch(`${EXACTITUDES_BASE}/serie?ID=${wpId}`);
  if (!res.ok) throw new Error(`serie fetch failed: ${res.status}`);
  const data = await res.json();
  const imgs = (data.post && data.post.imgs) || [];
  // "medium" is a consistent square-ish crop close to the original grid framing.
  return imgs
    .map(img => (img.sizes && (img.sizes.medium || img.sizes.large)) || img.url)
    .filter(Boolean);
}

function parseDataUrl(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 data URL image');
  return { mediaType: match[1], base64: match[2] };
}

async function classifyStyle(image, tribeList) {
  const { mediaType, base64 } = parseDataUrl(image);
  const tribeListText = tribeList
    .map(t => `${t.title} — ${t.location} ${t.year}`)
    .join('\n');

  let response;
  try {
    response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                'You are doing a visual style match for an Exactitudes-style installation. ' +
                'Exactitudes (Ari Versluis & Ellie Uyttenbroek) groups people into visual "tribes" by dress code. ' +
                'Given the attached photo of a visitor and the full list of real Exactitudes tribes below ' +
                '(each line is "<title> — <location> <year>"), pick the ONE tribe whose dress code most closely ' +
                "matches the visitor's clothing, hairstyle, and accessories ONLY. " +
                'Base the match strictly on what the visitor is wearing: garments, colors, silhouette, footwear, ' +
                'hairstyle, and accessories (bags, jewelry, glasses, headwear). ' +
                'Do NOT let the visitor\'s pose, stance, facial expression, or background/surroundings influence the ' +
                'match in any way — ignore all of that entirely and judge clothing and styling only. ' +
                'matched_title MUST be ONLY the title portion of that line, the text before the — character, ' +
                'copied exactly, character for character. Do NOT include the location or year in matched_title. ' +
                'For example, if the matching line is "200. Sad Ambient Boys — The Hague 2025", ' +
                'matched_title must be exactly "200. Sad Ambient Boys".\n\n' +
                `Tribe list:\n${tribeListText}`,
            },
            { inlineData: { mimeType: mediaType, data: base64 } },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            matched_title: {
              type: Type.STRING,
              description: 'Exact tribe title string, copied verbatim from the provided list.',
            },
            style_notes: {
              type: Type.STRING,
              description: 'One sentence on what was seen: colors, garments, silhouette, accessories.',
            },
            caption: {
              type: Type.STRING,
              description: 'One dry, observational sentence in the Exactitudes style, not a marketing tone.',
            },
          },
          required: ['matched_title', 'style_notes', 'caption'],
        },
      },
    });
  } catch (err) {
    const message = String(err && err.message || err);
    if (/429|RESOURCE_EXHAUSTED|quota/i.test(message)) {
      const rateLimitErr = new Error('AI provider rate-limited or quota exhausted');
      rateLimitErr.code = 'rate_limited';
      throw rateLimitErr;
    }
    const upstreamErr = new Error(`AI provider request failed: ${message}`);
    upstreamErr.code = 'ai_unavailable';
    throw upstreamErr;
  }

  if (!response.text) {
    const err = new Error('Gemini returned no text output');
    err.code = 'ai_unavailable';
    throw err;
  }
  try {
    return JSON.parse(response.text);
  } catch (err) {
    const parseErr = new Error('Gemini returned unparseable output');
    parseErr.code = 'ai_unavailable';
    throw parseErr;
  }
}

function findTribe(tribeList, rawTitle) {
  const raw = String(rawTitle || '').trim();
  if (!raw) return null;

  // The model sometimes echoes the whole "<title> — <location> <year>" line
  // instead of just the title, so strip anything from an em/en dash or hyphen onward.
  const cleaned = raw.split(/\s[—–-]\s/)[0].trim();

  return (
    tribeList.find(t => t.title === raw) ||
    tribeList.find(t => t.title === cleaned) ||
    tribeList.find(t => t.title.toLowerCase() === cleaned.toLowerCase()) ||
    // fall back to matching the leading catalog number, e.g. "200." in "200. Sad Ambient Boys"
    tribeList.find(t => {
      const num = cleaned.match(/^(\d+)\./);
      return num && t.title.startsWith(`${num[1]}.`);
    }) ||
    tribeList.find(t => t.title.toLowerCase().includes(cleaned.toLowerCase())) ||
    tribeList.find(t => cleaned.toLowerCase().includes(t.title.toLowerCase())) ||
    null
  );
}

// --- Reachability for the QR code (see Sharing / QR Code in the tech spec). ---
// Two modes: a plain LAN IP (works when the visitor's phone and this laptop
// are on the same, non-isolated network) or an ngrok tunnel (works anywhere,
// including networks with client/AP isolation, e.g. many campus Wi-Fi
// networks that silently block device-to-device traffic on the same SSID).
function detectLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}
const PUBLIC_HOST = process.env.PUBLIC_HOST || detectLanIp() || 'localhost';
const USE_NGROK = /^true$/i.test(process.env.USE_NGROK || '');

let PUBLIC_ORIGIN = `http://${PUBLIC_HOST}:${PORT}`; // overwritten below if ngrok is on
let ngrokListener = null;

async function setupPublicOrigin() {
  if (!USE_NGROK) return;
  if (!process.env.NGROK_AUTHTOKEN) {
    console.warn(
      'USE_NGROK is true but NGROK_AUTHTOKEN is not set in .env — get a free token at ' +
      'https://dashboard.ngrok.com/get-started/your-authtoken. Falling back to the LAN IP for now.'
    );
    return;
  }
  try {
    ngrokListener = await ngrok.connect({
      addr: PORT,
      authtoken: process.env.NGROK_AUTHTOKEN,
      domain: process.env.NGROK_DOMAIN || undefined, // set only if you have a reserved static domain
    });
    PUBLIC_ORIGIN = ngrokListener.url();
  } catch (err) {
    console.error('ngrok tunnel failed to start, falling back to the LAN IP:', err.message);
  }
}

async function shutdown() {
  if (ngrokListener) await ngrokListener.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Server-side compositing of the flattened, downloadable result image. ---
// Done here (not in-browser) because the grid includes exactitudes.com's
// hotlinked photos, which don't send CORS headers and would taint a client canvas.
const CELL = 300;
const GUTTER = 3;
const COLS = 4;
const ROWS = 3;
const TEXT_PANEL_H = 170;
const BG = { r: 244, g: 243, b: 240 };

async function fetchImageBuffer(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (exactitudes-mirror)' } });
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function escapeXml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

async function compositeResultImage({ visitorBuffer, imageUrls, tribeName, location, year, caption, credit, youIndex }) {
  const cellBuffers = await Promise.all(
    imageUrls.map(async (url, i) => {
      const src = i === youIndex ? visitorBuffer : await fetchImageBuffer(url);
      return sharp(src).resize(CELL, CELL, { fit: 'cover' }).jpeg().toBuffer();
    })
  );

  const gridW = COLS * CELL + (COLS - 1) * GUTTER;
  const gridH = ROWS * CELL + (ROWS - 1) * GUTTER;
  const width = gridW;
  const height = gridH + TEXT_PANEL_H;

  const composites = cellBuffers.map((buf, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    return {
      input: buf,
      left: col * (CELL + GUTTER),
      top: row * (CELL + GUTTER),
    };
  });

  const youBadgeSvg = `
    <svg width="${CELL}" height="${CELL}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${CELL - 46}" y="${CELL - 22}" width="42" height="18" fill="#ffffff" />
      <text x="${CELL - 25}" y="${CELL - 9}" font-family="Helvetica, Arial, sans-serif" font-size="10"
        letter-spacing="1" text-anchor="middle" fill="#111111">YOU</text>
    </svg>`;
  composites.push({
    input: Buffer.from(youBadgeSvg),
    left: (youIndex % COLS) * (CELL + GUTTER),
    top: Math.floor(youIndex / COLS) * (CELL + GUTTER),
  });

  const textSvg = `
    <svg width="${width}" height="${TEXT_PANEL_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${TEXT_PANEL_H}" fill="rgb(${BG.r},${BG.g},${BG.b})" />
      <text x="${width / 2}" y="34" font-family="Helvetica, Arial, sans-serif" font-size="26"
        font-weight="700" letter-spacing="1" text-anchor="middle" fill="#111111">${escapeXml(tribeName.toUpperCase())}</text>
      <text x="${width / 2}" y="58" font-family="Helvetica, Arial, sans-serif" font-size="14"
        text-anchor="middle" fill="#555555">${escapeXml(location)} — ${escapeXml(year)}</text>
      <text x="${width / 2}" y="88" font-family="Helvetica, Arial, sans-serif" font-size="14"
        font-style="italic" text-anchor="middle" fill="#333333">${escapeXml(caption)}</text>
      <text x="${width / 2}" y="${TEXT_PANEL_H - 16}" font-family="Helvetica, Arial, sans-serif" font-size="11"
        text-anchor="middle" fill="#777777">${escapeXml(credit)}</text>
    </svg>`;
  composites.push({ input: Buffer.from(textSvg), left: 0, top: gridH });

  return sharp({
    create: { width, height, channels: 3, background: BG },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

// --- Short-lived, unguessable result URLs for the QR code (FR8 / Sharing section). ---
// Deliberate, narrowly scoped exception to stateless-by-default (FR7): only to let
// the QR code work for a few minutes, not general persistence.
const resultFiles = new Map(); // id -> { path, timer }

function registerResult(id, filePath) {
  const timer = setTimeout(() => {
    fs.unlink(filePath, () => {});
    resultFiles.delete(id);
  }, RESULT_TTL_MS);
  timer.unref();
  resultFiles.set(id, { path: filePath, timer });
}

app.get('/results/:id.png', (req, res) => {
  const entry = resultFiles.get(req.params.id);
  if (!entry || !fs.existsSync(entry.path)) {
    return res.status(404).send('This result has expired.');
  }
  res.sendFile(entry.path);
});

app.get('/api/tribes', (req, res) => {
  try {
    res.json(loadTribes());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'tribes_unavailable', detail: err.message });
  }
});

app.post('/api/exactitude', async (req, res) => {
  try {
    const { image } = req.body; // data URL, e.g. "data:image/jpeg;base64,...."
    if (!image) return res.status(400).json({ error: 'missing_image' });

    const tribeList = loadTribes();

    let parsed;
    try {
      parsed = await classifyStyle(image, tribeList);
    } catch (err) {
      const status = err.code === 'rate_limited' ? 429 : 502;
      return res.status(status).json({ error: err.code || 'ai_unavailable', detail: err.message });
    }

    const matched = findTribe(tribeList, parsed.matched_title);
    if (!matched) {
      return res.status(502).json({ error: 'no_match', detail: 'Model did not return a recognizable tribe title', raw: parsed });
    }

    let images;
    try {
      images = (await getSeriesImages(matched.id)).slice(0, 11);
    } catch (err) {
      console.error(err);
      return res.status(502).json({ error: 'source_unavailable', detail: 'Could not reach exactitudes.com for portraits' });
    }
    if (images.length === 0) {
      return res.status(502).json({ error: 'source_unavailable', detail: 'exactitudes.com returned no portraits for this tribe' });
    }

    const credit = 'Portraits: Exactitudes by Ari Versluis & Ellie Uyttenbroek, exactitudes.com';
    const youIndex = Math.min(5, images.length);
    const allCells = [...images];
    allCells.splice(youIndex, 0, '__visitor__');

    let resultUrl = null;
    let qrCodeDataUrl = null;
    let expiresAt = null;
    try {
      const { base64 } = parseDataUrl(image);
      const visitorBuffer = Buffer.from(base64, 'base64');
      const png = await compositeResultImage({
        visitorBuffer,
        imageUrls: allCells.map(c => (c === '__visitor__' ? null : c)),
        tribeName: matched.name,
        location: matched.location,
        year: matched.year,
        caption: parsed.caption,
        credit,
        youIndex,
      });

      const id = crypto.randomUUID();
      const filePath = path.join(RESULTS_DIR, `${id}.png`);
      fs.writeFileSync(filePath, png);
      registerResult(id, filePath);

      resultUrl = `${PUBLIC_ORIGIN}/results/${id}.png`;
      expiresAt = new Date(Date.now() + RESULT_TTL_MS).toISOString();
      qrCodeDataUrl = await QRCode.toDataURL(resultUrl, { margin: 1, width: 360 });
    } catch (err) {
      // Compositing/QR is a nice-to-have on top of the on-screen result; don't
      // fail the whole request if it breaks, just omit the QR code.
      console.error('Compositing/QR failed:', err);
    }

    res.json({
      tribe: matched.name,
      location: matched.location,
      year: matched.year,
      styleNotes: parsed.style_notes,
      caption: parsed.caption,
      images, // real URLs, for the live on-screen grid
      credit,
      resultUrl,
      qrCodeDataUrl,
      expiresAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'unknown', detail: err.message });
  }
});

setupPublicOrigin().then(() => {
  app.listen(PORT, () => {
    console.log(`Exactitudes mirror running on http://localhost:${PORT}`);
    console.log(`QR codes will point to ${PUBLIC_ORIGIN} — open that URL from your phone to confirm it's reachable.`);
    if (USE_NGROK && ngrokListener) {
      console.log('ngrok tunnel is live: this URL is reachable from ANY network, not just this one — ' +
        'anyone with it can hit your Gemini-backed endpoint and burn your API quota. Stop the server ' +
        '(Ctrl+C) when you’re done testing/demoing.');
    } else if (PUBLIC_HOST === 'localhost' && !USE_NGROK) {
      console.log('WARNING: no LAN IP auto-detected and ngrok is off. Set PUBLIC_HOST in .env, or set ' +
        'USE_NGROK=true, or a phone will not be able to reach the QR code.');
    }
  });
});
