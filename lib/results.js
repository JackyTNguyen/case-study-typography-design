// Short-lived, unguessable results behind the QR code: the one deliberate
// exception to the app being stateless. Held in memory only and deleted after
// RESULT_TTL_MINUTES. Each result keeps what it needs to redraw itself, so the
// PNG can be rendered in the shape of whatever screen opens it.
const crypto = require('crypto');

const minutes = Number(process.env.RESULT_TTL_MINUTES);
const TTL_MS = (minutes > 0 ? minutes : 20) * 60 * 1000;
const MAX_RENDERS = 6; // a handful of screen shapes per result, not unbounded
const store = new Map();

// render(viewport) -> Promise<Buffer>
function create(render, defaultViewport) {
  const id = crypto.randomBytes(18).toString('base64url'); // 144 bits
  store.set(id, { render, defaultViewport, renders: new Map(), expiresAt: Date.now() + TTL_MS });
  setTimeout(() => store.delete(id), TTL_MS).unref();
  return id;
}

function live(id) {
  const e = store.get(id);
  return e && e.expiresAt >= Date.now() ? e : null;
}

// Round the aspect ratio so small differences (a phone toolbar sliding away)
// reuse the same render.
function pngFor(id, e, v) {
  const key = (v.w / v.h).toFixed(2);
  let png = e.renders.get(key);
  if (!png) {
    if (e.renders.size >= MAX_RENDERS) return e.renders.values().next().value;
    png = e.render(v);
    png.catch((err) => console.error(`[results] render ${id.slice(0, 6)}… failed: ${err.message}`));
    e.renders.set(key, png);
  }
  return png;
}

async function get(id, viewport) {
  const e = live(id);
  if (!e) return null;
  try {
    return await pngFor(id, e, viewport || e.defaultViewport);
  } catch {
    return null;
  }
}

// Start rendering the kiosk-shaped image straight away so the first scan is quick.
function warm(id) {
  const e = live(id);
  if (e) pngFor(id, e, e.defaultViewport);
}

module.exports = { create, get, warm, exists: (id) => Boolean(live(id)), TTL_MS };
