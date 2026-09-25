// Background-removed visitor photos, uploaded by the kiosk under a captureId
// while the AI match runs. Memory only, never disk, and gone within minutes.
// The upload and the request that needs it can arrive in either order.
const TTL_MS = 3 * 60 * 1000;
const MAX_ENTRIES = 50;
const store = new Map(); // captureId -> { done, buf, waiters: [], timer }

function entry(id) {
  let e = store.get(id);
  if (!e) {
    if (store.size >= MAX_ENTRIES) drop(store.keys().next().value);
    e = { done: false, buf: null, waiters: [], timer: setTimeout(() => drop(id), TTL_MS) };
    e.timer.unref();
    store.set(id, e);
  }
  return e;
}

function drop(id) {
  const e = store.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  e.waiters.forEach((w) => w(null));
  store.delete(id);
}

// buf = null means the kiosk gave up on background removal: stop waiting and
// let the caller fall back to the original photo straight away.
function put(id, buf) {
  const e = entry(id);
  e.done = true;
  e.buf = buf;
  e.waiters.splice(0).forEach((w) => w(buf));
}

// Resolves to the cut-out, or null if it hasn't arrived within waitMs.
// Picking it up removes it from this store; the caller now owns it.
function take(id, waitMs) {
  const e = entry(id);
  const done = (buf) => {
    drop(id);
    return buf;
  };
  if (e.done) return Promise.resolve(done(e.buf));
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(done(null)), waitMs);
    e.waiters.push((buf) => {
      clearTimeout(t);
      resolve(buf);
    });
  });
}

module.exports = { put, take };
