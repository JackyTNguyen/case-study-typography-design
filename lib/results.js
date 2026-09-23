// Short-lived, unguessable results for the QR code. Held in memory only (never
// written to disk) and deleted after RESULT_TTL_MINUTES. This is the one
// deliberate exception to the app being stateless.
//
// Each result keeps what it needs to re-draw itself (the match + the visitor's
// photo), so the PNG can be rendered at the exact shape of whatever screen opens
// it: a phone gets a phone-shaped image that fills it, the kiosk gets its own.
const crypto = require('crypto');

const TTL_MS = (Number(process.env.RESULT_TTL_MINUTES) > 0 ? Number(process.env.RESULT_TTL_MINUTES) : 20) * 60 * 1000;
const MAX_RENDERS_PER_RESULT = 6; // a handful of screen shapes, not unbounded
const store = new Map();

// render(viewport) -> Promise<Buffer>; defaultViewport is the kiosk screen.
function create(render, defaultViewport) {
  const id = crypto.randomBytes(18).toString('base64url');
  const entry = { render, defaultViewport, renders: new Map(), expiresAt: Date.now() + TTL_MS };
  store.set(id, entry);
  pngFor(id, entry, defaultViewport); // warm the kiosk-shaped version
  setTimeout(() => store.delete(id), TTL_MS).unref();
  return id;
}

// Round to a ratio so tiny differences (e.g. a browser toolbar showing/hiding)
// reuse the same render.
function keyFor(v) {
  const ratio = (v.w / v.h).toFixed(2);
  return ratio;
}

function pngFor(id, entry, viewport) {
  const key = keyFor(viewport);
  let png = entry.renders.get(key);
  if (!png) {
    if (entry.renders.size >= MAX_RENDERS_PER_RESULT) return entry.renders.values().next().value;
    png = entry.render(viewport);
    png.catch((err) => console.error(`[results] composite ${id.slice(0, 6)}… failed:`, err.message));
    entry.renders.set(key, png);
  }
  return png;
}

function exists(id) {
  const entry = store.get(id);
  return Boolean(entry && entry.expiresAt >= Date.now());
}

async function get(id, viewport) {
  const entry = store.get(id);
  if (!entry || entry.expiresAt < Date.now()) return null;
  const v = viewport && viewport.w > 0 && viewport.h > 0 ? viewport : entry.defaultViewport;
  try {
    return await pngFor(id, entry, v);
  } catch {
    return null;
  }
}

module.exports = { create, get, exists, TTL_MS };
