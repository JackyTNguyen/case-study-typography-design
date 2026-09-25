import { FilesetResolver, HandLandmarker } from '/vendor/mediapipe/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);
const video = $('camera');
const params = new URLSearchParams(location.search);

const HAND_MODEL_LOCAL = '/models/hand_landmarker.task';
const HAND_MODEL_CDN =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const CAPTURE_SIZE = 768; // square JPEG sent to the server
const RESULT_SECONDS = 90; // result screen returns to idle on its own
const ERROR_SECONDS = 25;
const MULTI_CYCLE_SECONDS = 14;

let config = { countdownSeconds: 3, dwellMs: 1200, voiceLang: 'en-US', tribeNames: [], resultTtlMinutes: 20 };
let state = 'idle';
let visitorPhoto = null; // data URL, only while a result is on screen
let timers = [];

// ---------------------------------------------------------------- state
function setState(next) {
  state = next;
  document.body.dataset.state = next;
  resetDwell();
  dwell.armed = false;
}

function later(fn, ms) {
  const t = setTimeout(fn, ms);
  timers.push(t);
  return t;
}
function clearTimers() {
  timers.forEach(clearTimeout);
  timers.forEach(clearInterval);
  timers = [];
}

function toIdle() {
  clearTimers();
  visitorPhoto = null;
  $('grid').replaceChildren();
  $('r-qr').replaceChildren();
  setState('idle');
}

// ---------------------------------------------------------------- camera
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise((r) => (video.readyState >= 1 ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  await video.play();
}

// How the (object-fit: cover, mirrored) video maps onto the screen.
function videoGeometry() {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const sw = window.innerWidth;
  const sh = window.innerHeight;
  const scale = Math.max(sw / vw, sh / vh);
  return { vw, vh, sw, sh, scale, ox: (sw - vw * scale) / 2, oy: (sh - vh * scale) / 2 };
}

// The square that gets captured. On a landscape screen it sits right of the
// consent panel (centred on GUIDE_CENTER_X of the screen) so the two don't overlap.
const GUIDE_CENTER_X = 0.66;
function captureSquare() {
  const { vw, vh, sw, sh, scale, ox } = videoGeometry();
  const side = Math.min(vw, vh);
  let sx = (vw - side) / 2;
  if (sw > sh) {
    const screenX = sw * GUIDE_CENTER_X;
    const videoX = (sw - screenX - ox) / scale; // undo the mirror and the cover crop
    sx = Math.min(vw - side, Math.max(0, videoX - side / 2));
  }
  return { sx, sy: (vh - side) / 2, side };
}

// Put the standing guide exactly over the part of the feed that will be captured.
function placeStage() {
  const g = videoGeometry();
  const sq = captureSquare();
  const size = sq.side * g.scale;
  const left = g.sw - (g.ox + (sq.sx + sq.side) * g.scale); // mirrored
  const top = g.oy + sq.sy * g.scale;
  // Keep the guide on screen if the viewport crops the feed.
  const fit = Math.min(size, g.sw, g.sh);
  Object.assign($('stage').style, {
    width: `${fit}px`,
    height: `${fit}px`,
    left: `${left + (size - fit) / 2}px`,
    top: `${Math.max(0, top + (size - fit) / 2)}px`,
  });
  document.documentElement.style.setProperty('--bar-h', `${MirrorLayout.barHeight(g.sw, g.sh)}px`);
}

function grabSquareJpeg() {
  const { sx, sy, side } = captureSquare();
  const canvas = $('grab');
  canvas.width = canvas.height = CAPTURE_SIZE;
  const ctx = canvas.getContext('2d');
  // Unmirrored, so text on clothing reads the right way round.
  ctx.drawImage(video, sx, sy, side, side, 0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
  const url = canvas.toDataURL('image/jpeg', 0.88);
  ctx.clearRect(0, 0, CAPTURE_SIZE, CAPTURE_SIZE);
  return url;
}

// ---------------------------------------------------------------- hand tracking + dwell
let landmarker = null;
let lastVideoTime = -1;
let pointers = []; // screen-space points from hands (or the mouse in ?mouse=1 mode)
// `armed` stays false after a screen change until no hand is on any button, so a
// hand left raised can't fire the next screen's button by accident.
const dwell = { el: null, since: 0, lostAt: 0, armed: false };

async function startHands() {
  const fileset = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
  const make = (modelAssetPath, delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  const local = await fetch(HAND_MODEL_LOCAL, { method: 'HEAD' }).then((r) => r.ok, () => false);
  const model = local ? HAND_MODEL_LOCAL : HAND_MODEL_CDN;
  try {
    landmarker = await make(model, 'GPU');
  } catch {
    landmarker = await make(model, 'CPU');
  }
}

function trackHands() {
  if (landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime && state !== 'loading') {
    lastVideoTime = video.currentTime;
    const res = landmarker.detectForVideo(video, performance.now());
    const g = videoGeometry();
    pointers = (res.landmarks || []).map((lm) => {
      // Palm centre: wrist plus the knuckles.
      const pts = [0, 5, 9, 13, 17].map((i) => lm[i]);
      const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      return { x: g.sw - (g.ox + x * g.vw * g.scale), y: g.oy + y * g.vh * g.scale };
    });
  }
  drawCursors();
  updateDwell();
  requestAnimationFrame(trackHands);
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

function activeTargets() {
  const screen = document.querySelector(`#${state}`);
  return screen ? [...screen.querySelectorAll('[data-dwell]')] : [];
}

function hit(el) {
  const r = el.getBoundingClientRect();
  const pad = r.width * 0.15; // be a little forgiving
  return pointers.some((p) => p.x > r.left - pad && p.x < r.right + pad && p.y > r.top - pad && p.y < r.bottom + pad);
}

function updateDwell() {
  const now = performance.now();
  const target = activeTargets().find(hit) || null;

  if (!dwell.armed) {
    if (!target) dwell.armed = true;
    return;
  }
  if (target && target === dwell.el) {
    dwell.lostAt = 0;
  } else if (target) {
    resetDwell();
    dwell.el = target;
    dwell.since = now;
    target.classList.add('hovering');
  } else if (dwell.el) {
    // Tracking flickers; allow a short gap before giving up.
    if (!dwell.lostAt) dwell.lostAt = now;
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
  dwell.el = null;
  dwell.lostAt = 0;
}

// ---------------------------------------------------------------- actions
function run(action) {
  if (action === 'capture' && state === 'idle') countdown();
  else if (action === 'reset' && (state === 'result' || state === 'error')) toIdle();
}

function countdown() {
  setState('countdown');
  let n = config.countdownSeconds;
  const el = $('count-number');
  el.textContent = n;
  const tick = setInterval(() => {
    n -= 1;
    if (n > 0) {
      el.textContent = n;
      // restart the CSS tick animation
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    } else {
      clearInterval(tick);
      capture();
    }
  }, 1000);
  timers.push(tick);
}

async function capture() {
  const flash = $('flash');
  flash.classList.remove('go');
  void flash.offsetWidth;
  flash.classList.add('go');

  visitorPhoto = grabSquareJpeg();
  setState('loading');
  const stopBanner = runBanner();

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch('/api/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: visitorPhoto, viewport: { w: window.innerWidth, h: window.innerHeight } }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !Array.isArray(data.matches) || !data.matches.length) {
      throw Object.assign(new Error('match failed'), { code: data && data.error && data.error.code });
    }
    await preload(data.matches[0].images);
    stopBanner();
    showResult(data);
  } catch (err) {
    stopBanner();
    showError(err.name === 'AbortError' ? 'TIMEOUT' : err.code);
  }
}

// Give the grid a moment to arrive together instead of popping in piecemeal.
function preload(urls) {
  const each = urls.map(
    (u) =>
      new Promise((r) => {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.onload = img.onerror = r;
        img.src = u;
      })
  );
  return Promise.race([Promise.all(each), new Promise((r) => setTimeout(r, 4000))]);
}

// ---------------------------------------------------------------- loading banner
function runBanner() {
  const word = $('banner-word');
  const sub = $('banner-sub');
  const names = config.tribeNames.length ? config.tribeNames : ['Exactitudes'];
  const lines = ['Reading your dress code', `Comparing with ${names.length} tribes`, 'Fetching the series'];
  let i = 0;
  const flip = setInterval(() => {
    const name = names[Math.floor(Math.random() * names.length)];
    word.textContent = name;
    word.style.setProperty('--len', Math.max(8, name.length));
  }, 160);
  const step = setInterval(() => {
    i = Math.min(i + 1, lines.length - 1);
    sub.textContent = lines[i];
  }, 2800);
  sub.textContent = lines[0];
  return () => {
    clearInterval(flip);
    clearInterval(step);
  };
}

// ---------------------------------------------------------------- result
function showResult(data) {
  const matches = data.matches;
  $('r-credit').textContent = data.credit;
  let index = 0;
  renderMatch(matches[0], 0, matches.length);
  setState('result');

  if (matches.length > 1) {
    const cycle = setInterval(() => {
      index = (index + 1) % matches.length;
      renderMatch(matches[index], index, matches.length);
    }, MULTI_CYCLE_SECONDS * 1000);
    timers.push(cycle);
  }

  // Quiet return to idle, shown as a shrinking line under the bar.
  const bar = $('auto-reset');
  const started = Date.now();
  const drain = setInterval(() => {
    const left = 1 - (Date.now() - started) / (RESULT_SECONDS * 1000);
    bar.style.setProperty('--left', Math.max(0, left));
    if (left <= 0) toIdle();
  }, 250);
  timers.push(drain);
}

function renderMatch(m, i, total) {
  const [, num, name] = m.title.match(/^(\d+)\.\s*(.*)$/) || [null, '', m.title];
  $('r-num').textContent = num;
  $('r-name').textContent = name;
  $('r-meta').textContent = [m.location, m.year].filter(Boolean).join(', ');
  $('r-context').textContent = m.styleDescription;
  $('r-caption').textContent = m.caption;
  $('r-qr').innerHTML = m.qrSvg; // generated by our own server from our own URL
  const count = $('r-count');
  count.hidden = total < 2;
  count.textContent = total > 1 ? `Match ${i + 1} of ${total}. Your style overlaps more than one tribe.` : '';

  const cells = [...m.images];
  cells.splice(m.visitorIndex, 0, null); // null marks the visitor
  const nodes = cells.map((src, k) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const img = document.createElement('img');
    img.alt = '';
    img.style.setProperty('--i', k);
    if (src === null) {
      cell.classList.add('visitor');
      img.src = visitorPhoto;
      img.alt = 'You';
    } else {
      img.referrerPolicy = 'no-referrer';
      img.src = src;
      img.onerror = () => img.remove();
    }
    cell.append(img);
    return cell;
  });
  $('grid').replaceChildren(...nodes);
  layoutGrid();
}

// Fit the photo cells to the current screen, edge to edge with no empty slots.
// Runs again on every resize/rotation, portrait or landscape.
function layoutGrid() {
  const grid = $('grid');
  const cells = [...grid.children];
  if (!cells.length) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const bar = MirrorLayout.barHeight(W, H);
  document.documentElement.style.setProperty('--bar-h', `${bar}px`);
  const { rects } = MirrorLayout.tiles(cells.length, W, H - bar);
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

// ---------------------------------------------------------------- error
const ERRORS = {
  RATE_LIMITED: ['Busy.', 'The archive or the style matcher is getting a lot of requests. Give it a few seconds and try again.'],
  SOURCE_UNAVAILABLE: ['Offline.', "We couldn't reach the Exactitudes archive just now. Your photo wasn't kept."],
  SOURCE_CHANGED: ['Offline.', "The Exactitudes archive answered in a way we didn't expect. Your photo wasn't kept."],
  AI_UNAVAILABLE: ['Hmm.', "The style matcher didn't respond. Your photo wasn't kept."],
  AI_BAD_RESPONSE: ['Hmm.', "The style matcher couldn't place you this time. Try again, maybe step a little closer."],
  TIMEOUT: ['Slow.', 'That took too long. Your photo wasn\'t kept. Try again?'],
};

function showError(code) {
  const [title, text] = ERRORS[code] || ['Hmm.', "Something went wrong. Your photo wasn't kept."];
  visitorPhoto = null;
  $('error-title').textContent = title;
  $('error-text').textContent = text;
  setState('error');
  later(toIdle, ERROR_SECONDS * 1000);
}

// ---------------------------------------------------------------- input fallbacks
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    run(state === 'idle' ? 'capture' : 'reset');
  } else if (e.key === 'Escape' || e.key.toLowerCase() === 'r') run('reset');
});

if (params.has('mouse')) {
  // Testing aid: the mouse pointer behaves like a tracked hand.
  document.body.classList.add('debug-cursor');
  window.addEventListener('pointermove', (e) => {
    pointers = [{ x: e.clientX, y: e.clientY }];
  });
}

function status(msg) {
  $('status').textContent = msg || '';
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    config = { ...config, ...(await fetch('/api/config').then((r) => r.json())) };
  } catch {}
  document.querySelectorAll('[data-ttl]').forEach((el) => (el.textContent = Math.round(config.resultTtlMinutes)));

  window.addEventListener('resize', () => {
    placeStage();
    if (state === 'result') layoutGrid();
  });
  placeStage();

  try {
    await startCamera();
    placeStage();
  } catch (err) {
    status('Camera unavailable: ' + err.message);
  }

  if (!params.has('mouse')) {
    try {
      await startHands();
    } catch (err) {
      status('Hand tracking unavailable. Use voice or the space bar.');
      console.error(err);
    }
  }
  requestAnimationFrame(trackHands);

  const voice = window.MirrorVoice.start({
    lang: config.voiceLang,
    onCommand: (action) => run(action),
    onStatus: (s) => {
      document.querySelector('.voice-hint').hidden = s !== 'listening';
    },
  });
  if (!voice.supported) document.querySelector('.voice-hint').hidden = true;
}

boot();
