import { FilesetResolver, HandLandmarker } from '/vendor/mediapipe/vision_bundle.mjs';
import { loadSegmenter, cutOut } from '/js/segment.js';

const $ = (id) => document.getElementById(id);
const video = $('camera');
const params = new URLSearchParams(location.search);

const HAND_MODEL_LOCAL = '/models/hand_landmarker.task';
const HAND_MODEL_CDN =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const CAPTURE_SIZE = 768; // square JPEG, matches the archive's square framing
const RESULT_SECONDS = 90; // the result screen returns to idle on its own
const ERROR_SECONDS = 25;
const MULTI_CYCLE_SECONDS = 14;

let config = { countdownSeconds: 3, dwellMs: 1200, voiceLang: 'en-US', tribeNames: [], resultTtlMinutes: 20 };
let state = 'idle';
let visitorPhoto = null; // cut-out (or original) data URL, only while a result is on screen
let timers = [];

// ================================================================ state
function setState(next) {
  state = next;
  document.body.dataset.state = next;
  resetDwell();
  dwell.armed = false; // a hand already on a button must leave before it counts
}

function track(id) {
  timers.push(id);
  return id;
}
function clearTimers() {
  timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
  timers = [];
}

function toIdle() {
  clearTimers();
  visitorPhoto = null;
  $('grid').replaceChildren();
  $('r-qr').replaceChildren();
  setState('idle');
}

// ================================================================ camera
async function startCamera() {
  if (params.get('fakecam')) return startFakeCamera(params.get('fakecam'));
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  await video.play();
}

// Testing aid: ?fakecam=<image url> feeds a still image in as the camera.
// The image must be same-origin or CORS-enabled so its pixels can be read.
async function startFakeCamera(src) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext('2d');
  const paint = () => {
    ctx.fillStyle = '#777';
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.drawImage(img, 1920 / 2 - 540, 0, 1080, 1080);
  };
  paint();
  setInterval(paint, 200);
  video.srcObject = canvas.captureStream(15);
  await video.play();
}

// How the mirrored, object-fit: cover video maps onto the screen.
function geometry() {
  const vw = video.videoWidth || 1920;
  const vh = video.videoHeight || 1080;
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const scale = Math.max(sw / vw, sh / vh);
  return { vw, vh, sw, sh, scale, ox: (sw - vw * scale) / 2, oy: (sh - vh * scale) / 2 };
}

// Where the standing guide sits on screen; this square is exactly what gets
// captured. Landscape: right of the consent panel, full height. Portrait: full
// width near the top, with the consent panel underneath.
function stageRect() {
  const { sw, sh } = geometry();
  if (sh > sw) {
    const size = Math.min(sw, sh * 0.62);
    return { x: (sw - size) / 2, y: sh * 0.06, size };
  }
  const size = Math.min(sh, sw * 0.6);
  const cx = Math.min(sw - size / 2, sw * 0.66);
  return { x: cx - size / 2, y: (sh - size) / 2, size };
}

// The same square, in (unmirrored) video pixels.
function captureRect() {
  const g = geometry();
  const s = stageRect();
  const side = s.size / g.scale;
  const x = (g.sw - (s.x + s.size) - g.ox) / g.scale; // undo the mirror and the cover crop
  const y = (s.y - g.oy) / g.scale;
  return {
    sx: Math.min(Math.max(0, x), g.vw - side),
    sy: Math.min(Math.max(0, y), g.vh - side),
    side: Math.min(side, g.vw, g.vh),
  };
}

function placeStage() {
  const s = stageRect();
  Object.assign($('stage').style, { left: `${s.x}px`, top: `${s.y}px`, width: `${s.size}px`, height: `${s.size}px` });
  document.documentElement.style.setProperty('--bar-h', `${MirrorLayout.barHeight(innerWidth, innerHeight)}px`);
}

// Square, unmirrored still (text on clothing reads the right way round).
function grabSquare() {
  const { sx, sy, side } = captureRect();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CAPTURE_SIZE;
  canvas.getContext('2d').drawImage(video, sx, sy, side, side, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
  return canvas;
}

// ================================================================ hand tracking + dwell
let landmarker = null;
let lastVideoTime = -1;
let pointers = []; // screen-space hand positions (or the mouse with ?mouse=1)
const dwell = { el: null, since: 0, lostAt: 0, armed: false };

async function startHands(fileset) {
  const local = await fetch(HAND_MODEL_LOCAL, { method: 'HEAD' }).then((r) => r.ok, () => false);
  const make = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: local ? HAND_MODEL_LOCAL : HAND_MODEL_CDN, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
    });
  try {
    landmarker = await make('GPU');
  } catch {
    landmarker = await make('CPU');
  }
}

function tick() {
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime && state !== 'loading') {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    const g = geometry();
    pointers = (res.landmarks || []).map((lm) => {
      // Palm centre: the wrist plus the four knuckles.
      const pts = [0, 5, 9, 13, 17].map((i) => lm[i]);
      const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      return { x: g.sw - (g.ox + x * g.vw * g.scale), y: g.oy + y * g.vh * g.scale };
    });
  }
  drawCursors();
  updateDwell();
  requestAnimationFrame(tick);
}

function drawCursors() {
  const layer = $('hand-cursors');
  while (layer.children.length < pointers.length) {
    const d = document.createElement('div');
    d.className = 'hand-cursor';
    layer.append(d);
  }
  [...layer.children].forEach((d, i) => {
    const p = pointers[i];
    d.hidden = !p;
    if (p) Object.assign(d.style, { left: `${p.x}px`, top: `${p.y}px` });
  });
}

function targetUnderHand() {
  const screen = $(state);
  if (!screen) return null;
  return (
    [...screen.querySelectorAll('[data-dwell]')].find((el) => {
      const r = el.getBoundingClientRect();
      const pad = r.width * 0.15; // a little forgiving
      return pointers.some((p) => p.x > r.left - pad && p.x < r.right + pad && p.y > r.top - pad && p.y < r.bottom + pad);
    }) || null
  );
}

function updateDwell() {
  const now = performance.now();
  const target = targetUnderHand();

  if (!dwell.armed) {
    if (!target) dwell.armed = true;
    return;
  }
  if (target && target === dwell.el) {
    dwell.lostAt = 0;
  } else if (target) {
    resetDwell();
    Object.assign(dwell, { el: target, since: now });
    target.classList.add('hovering');
  } else if (dwell.el) {
    // Tracking flickers; allow a short gap before giving up.
    dwell.lostAt = dwell.lostAt || now;
    if (now - dwell.lostAt > 250) resetDwell();
  }
  if (!dwell.el) return;

  const p = Math.min(1, (now - dwell.since) / config.dwellMs);
  dwell.el.style.setProperty('--p', p);
  if (p >= 1) {
    const action = dwell.el.dataset.dwell;
    resetDwell();
    run(action);
  }
}

function resetDwell() {
  if (dwell.el) {
    dwell.el.classList.remove('hovering');
    dwell.el.style.setProperty('--p', 0);
  }
  Object.assign(dwell, { el: null, lostAt: 0 });
}

// ================================================================ actions
function run(action) {
  if (action === 'capture' && state === 'idle') countdown();
  else if (action === 'reset' && (state === 'result' || state === 'error')) toIdle();
}

function countdown() {
  setState('countdown');
  let n = config.countdownSeconds;
  const el = $('count-number');
  el.textContent = n;
  const t = track(
    setInterval(() => {
      n -= 1;
      if (n > 0) {
        el.textContent = n;
        el.style.animation = 'none'; // restart the tick animation
        void el.offsetWidth;
        el.style.animation = '';
      } else {
        clearInterval(t);
        capture();
      }
    }, 1000)
  );
}

const post = (url, body, signal) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

// The photo goes two ways at once: the original to the server for the AI match,
// and through the segmenter here for the cut-out. Neither waits for the other.
async function capture() {
  const flash = $('flash');
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');

  const t0 = performance.now();
  const captureId = crypto.randomUUID();
  const photo = grabSquare();
  const original = photo.toDataURL('image/jpeg', 0.88);
  setState('loading');
  const stopBanner = runBanner();

  // (1) AI match on the original photo, sent straight away.
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 60000);
  const match = post('/api/match', { captureId, image: original, viewport: { w: innerWidth, h: innerHeight } }, ctrl.signal)
    .then(async (res) => {
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !Array.isArray(data.matches) || !data.matches.length) {
        throw Object.assign(new Error('match failed'), { code: data && data.error && data.error.code });
      }
      console.info(`[timing] AI match ${Math.round(performance.now() - t0)}ms`);
      return data;
    })
    .finally(() => clearTimeout(timeout));

  // (2) Background removal in the browser, in parallel. Never blocks the visitor:
  // any failure just means the original photo is used.
  const visitor = (async () => {
    await new Promise((r) => setTimeout(r)); // let the match request go out first
    let cut = null;
    const s0 = performance.now();
    try {
      cut = await cutOut(photo);
    } catch (err) {
      console.warn('Background removal failed:', err);
    }
    const now = performance.now();
    console.info(`[timing] cut-out ${cut ? 'ready' : 'skipped'} ${Math.round(now - t0)}ms (segmentation ${Math.round(now - s0)}ms)`);
    post('/api/cutout', cut ? { captureId, image: cut } : { captureId, failed: true }).catch(() => {});
    return cut || original;
  })();

  try {
    const [data, src] = await Promise.all([match, visitor]);
    visitorPhoto = src;
    await preload(data.matches[0].images);
    stopBanner();
    showResult(data);
  } catch (err) {
    stopBanner();
    showError(err.name === 'AbortError' ? 'TIMEOUT' : err.code);
  }
}

// Let the grid arrive together rather than popping in tile by tile.
function preload(urls) {
  const all = urls.map(
    (u) =>
      new Promise((r) => {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.onload = img.onerror = r;
        img.src = u;
      })
  );
  return Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, 4000))]);
}

// ================================================================ loading banner
function runBanner() {
  const word = $('banner-word');
  const sub = $('banner-sub');
  const names = config.tribeNames.length ? config.tribeNames : ['Exactitudes'];
  const lines = ['Reading your dress code', `Comparing with ${names.length} tribes`, 'Fetching the series'];
  let i = 0;
  sub.textContent = lines[0];
  const flip = setInterval(() => {
    const name = names[Math.floor(Math.random() * names.length)];
    word.textContent = name;
    word.style.setProperty('--len', Math.max(8, name.length));
  }, 160);
  const step = setInterval(() => (sub.textContent = lines[(i = Math.min(i + 1, lines.length - 1))]), 2800);
  return () => (clearInterval(flip), clearInterval(step));
}

// ================================================================ result
function showResult(data) {
  const { matches } = data;
  $('r-credit').textContent = data.credit;
  let index = 0;
  renderMatch(matches[0], 0, matches.length);
  setState('result');

  if (matches.length > 1) {
    track(
      setInterval(() => {
        index = (index + 1) % matches.length;
        renderMatch(matches[index], index, matches.length);
      }, MULTI_CYCLE_SECONDS * 1000)
    );
  }

  // Quiet return to idle, shown as a shrinking line under the bar.
  const started = Date.now();
  track(
    setInterval(() => {
      const left = 1 - (Date.now() - started) / (RESULT_SECONDS * 1000);
      $('auto-reset').style.setProperty('--left', Math.max(0, left));
      if (left <= 0) toIdle();
    }, 250)
  );
}

function renderMatch(m, i, total) {
  const [, num, name] = m.title.match(/^(\d+)\.\s*(.*)$/) || [null, '', m.title];
  $('r-num').textContent = num;
  $('r-name').textContent = name;
  $('r-meta').textContent = [m.location, m.year].filter(Boolean).join(', ');
  $('r-context').textContent = m.styleDescription;
  $('r-caption').textContent = m.caption;
  $('r-qr').innerHTML = m.qrSvg; // generated by our own server from our own URL
  $('r-count').hidden = total < 2;
  $('r-count').textContent = total > 1 ? `Match ${i + 1} of ${total}. Your style overlaps more than one tribe.` : '';

  const sources = [...m.images];
  sources.splice(m.visitorIndex, 0, null); // null marks the visitor
  $('grid').replaceChildren(
    ...sources.map((src, k) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const img = document.createElement('img');
      img.style.setProperty('--i', k);
      if (src === null) {
        cell.classList.add('visitor');
        img.src = visitorPhoto;
        img.alt = 'You';
      } else {
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        img.src = src;
        img.onerror = () => img.remove();
      }
      cell.append(img);
      return cell;
    })
  );
  layoutGrid();
}

// Every cell edge to edge, no empty slots; re-run on resize and rotation.
function layoutGrid() {
  const cells = [...$('grid').children];
  if (!cells.length) return;
  const bar = MirrorLayout.barHeight(innerWidth, innerHeight);
  document.documentElement.style.setProperty('--bar-h', `${bar}px`);
  const { rects } = MirrorLayout.tiles(cells.length, innerWidth, innerHeight - bar);
  cells.forEach((cell, k) => {
    const r = rects[k];
    Object.assign(cell.style, {
      left: `${r.x * 100}%`,
      top: `${r.y * 100}%`,
      // +1px overlap hides sub-pixel seams between neighbours
      width: `calc(${r.w * 100}% + 1px)`,
      height: `calc(${r.h * 100}% + 1px)`,
    });
  });
}

// ================================================================ error
const ERRORS = {
  RATE_LIMITED: ['Busy.', 'The archive or the style matcher is getting a lot of requests. Give it a few seconds and try again.'],
  SOURCE_UNAVAILABLE: ['Offline.', "We couldn't reach the Exactitudes archive just now. Your photo wasn't kept."],
  SOURCE_CHANGED: ['Offline.', "The Exactitudes archive answered in a way we didn't expect. Your photo wasn't kept."],
  AI_UNAVAILABLE: ['Hmm.', "The style matcher didn't respond. Your photo wasn't kept."],
  AI_BAD_RESPONSE: ['Hmm.', "The style matcher couldn't place you this time. Try again, maybe step a little closer."],
  TIMEOUT: ['Slow.', "That took too long. Your photo wasn't kept. Try again?"],
};

function showError(code) {
  const [title, text] = ERRORS[code] || ['Hmm.', "Something went wrong. Your photo wasn't kept."];
  visitorPhoto = null;
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  setState('error');
  track(setTimeout(toIdle, ERROR_SECONDS * 1000));
}

// ================================================================ fallbacks + boot
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    run(state === 'idle' ? 'capture' : 'reset');
  } else if (e.key === 'Escape' || e.key.toLowerCase() === 'r') run('reset');
});

if (params.has('mouse')) {
  // Testing aid: the mouse pointer acts as a tracked hand.
  document.body.classList.add('debug-cursor');
  addEventListener('pointermove', (e) => (pointers = [{ x: e.clientX, y: e.clientY }]));
}

const status = (msg) => ($('status').textContent = msg || '');

async function boot() {
  try {
    config = { ...config, ...(await fetch('/api/config').then((r) => r.json())) };
  } catch {}
  document.querySelectorAll('[data-ttl]').forEach((el) => (el.textContent = Math.round(config.resultTtlMinutes)));

  addEventListener('resize', () => {
    placeStage();
    if (state === 'result') layoutGrid();
  });
  placeStage();

  try {
    await startCamera();
    placeStage();
  } catch (err) {
    status(`Camera unavailable: ${err.message}`);
  }

  // Both models load at startup so they're ready before the first capture.
  const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const [hands, seg] = await Promise.allSettled([params.has('mouse') ? null : startHands(fileset), loadSegmenter(fileset)]);
  if (hands.status === 'rejected') {
    console.error(hands.reason);
    status('Hand tracking unavailable. Use voice or the space bar.');
  }
  if (seg.status === 'rejected') console.warn('Segmenter unavailable; original photos will be used.', seg.reason);
  requestAnimationFrame(tick);

  const voice = window.MirrorVoice.start({
    lang: config.voiceLang,
    onCommand: run,
    onStatus: (s) => (document.querySelector('.voice-hint').hidden = s !== 'listening'),
  });
  if (!voice.supported) document.querySelector('.voice-hint').hidden = true;
}

boot();
