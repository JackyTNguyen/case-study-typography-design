// Background-removed visitor photos, uploaded by the kiosk under a captureId
// while the AI match runs. Memory only, never disk, and gone within minutes.
// The upload and the request that needs it can arrive in either order.
const TTL_MS = 3 * 60 * 1000;
const MAX_ENTRIES = 50;
const store = new Map(); // captureId -> { done, value: { buf, box } | null, waiters: [], timer }

function entry(id) {
  let e = store.get(id);
  if (!e) {
    if (store.size >= MAX_ENTRIES) drop(store.keys().next().value);
    e = { done: false, value: null, waiters: [], timer: setTimeout(() => drop(id), TTL_MS) };
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

// value = null means the kiosk gave up on background removal: stop waiting and
// let the caller fall back to the original photo straight away.
function put(id, value) {
  const e = entry(id);
  e.done = true;
  e.value = value;
  e.waiters.splice(0).forEach((w) => w(value));
}

// Resolves to the cut-out, or null if it hasn't arrived within waitMs.
// Picking it up removes it from this store; the caller now owns it.
function take(id, waitMs) {
  const e = entry(id);
  const done = (value) => {
    drop(id);
    return value;
  };
  if (e.done) return Promise.resolve(done(e.value));
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(done(null)), waitMs);
    e.waiters.push((value) => {
      clearTimeout(t);
      resolve(value);
    });
  });
}

module.exports = { put, take };
