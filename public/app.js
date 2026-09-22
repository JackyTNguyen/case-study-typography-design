import { HandLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/vision_bundle.mjs';

const COUNTDOWN_SECONDS = 3;
const DWELL_MS = 1200; // hold hand over the button this long to trigger capture
const DWELL_GRACE_MS = 250; // brief tolerance for tracking jitter before resetting dwell
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const captureBtn = document.getElementById('captureBtn');
const ringProgress = document.getElementById('ringProgress');
const againBtn = document.getElementById('againBtn');
const retryBtn = document.getElementById('retryBtn');
const countdownEl = document.getElementById('countdown');

const captureScreen = document.getElementById('captureScreen');
const loadingScreen = document.getElementById('loadingScreen');
const resultScreen = document.getElementById('resultScreen');
const errorScreen = document.getElementById('errorScreen');

const tribeNameEl = document.getElementById('tribeName');
const tribeMetaEl = document.getElementById('tribeMeta');
const captionEl = document.getElementById('caption');
const gridEl = document.getElementById('grid');
const creditEl = document.getElementById('credit');
const qrEl = document.getElementById('qrCode');
const errorMessageEl = document.getElementById('errorMessage');

const RING_CIRCUMFERENCE = 2 * Math.PI * 44;

let handLandmarker = null;
let dwellActive = false; // true while hand-tracking capture is allowed (idle/capture state only)
let dwellStart = null;
let lastOverlapAt = null;
let capturing = false; // countdown/capture in progress, ignore dwell

function showScreen(el) {
  [captureScreen, loadingScreen, resultScreen, errorScreen].forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

function setDwellUi(progress) {
  ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));
  captureBtn.classList.toggle('is-active', progress > 0);
}

function resetDwell() {
  dwellStart = null;
  lastOverlapAt = null;
  setDwellUi(0);
}

// --- Camera ---

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  await new Promise(resolve => { video.onloadedmetadata = resolve; });
  await video.play();
}

// --- Hand tracking ---

async function initHandTracking() {
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm'
  );
  const baseOptions = { modelAssetPath: HAND_MODEL_URL };
  try {
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { ...baseOptions, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
    });
  } catch (err) {
    console.warn('GPU delegate failed, falling back to CPU for hand tracking', err);
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { ...baseOptions, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 1,
    });
  }
  requestAnimationFrame(trackingLoop);
}

// Maps a landmark's normalized (0-1) video-frame coordinate to a mirrored
// on-screen pixel coordinate, accounting for object-fit: cover cropping and
// the CSS scaleX(-1) mirror applied to the <video> element.
function landmarkToScreenPoint(x, y) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const iw = window.innerWidth;
  const ih = window.innerHeight;
  const scale = Math.max(iw / vw, ih / vh);
  const dispW = vw * scale;
  const dispH = vh * scale;
  const offsetX = (iw - dispW) / 2;
  const offsetY = (ih - dispH) / 2;

  const rawScreenX = offsetX + x * dispW;
  const screenY = offsetY + y * dispH;
  const mirroredScreenX = iw - rawScreenX;

  return { x: mirroredScreenX, y: screenY };
}

function trackingLoop(timestampMs) {
  requestAnimationFrame(trackingLoop);
  if (!handLandmarker || video.readyState < 2) return;

  let result;
  try {
    result = handLandmarker.detectForVideo(video, timestampMs);
  } catch (err) {
    return;
  }

  if (!dwellActive || capturing) {
    resetDwell();
    return;
  }

  const landmarks = result.landmarks && result.landmarks[0];
  if (!landmarks) {
    handleNoOverlap();
    return;
  }

  // Landmark 9 = middle-finger MCP, a stable approximation of the palm center.
  const palm = landmarks[9];
  const point = landmarkToScreenPoint(palm.x, palm.y);
  if (!point) { handleNoOverlap(); return; }

  const rect = captureBtn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = rect.width / 2 + 20; // slightly forgiving hit area
  const dist = Math.hypot(point.x - cx, point.y - cy);

  if (dist <= radius) {
    const now = performance.now();
    if (dwellStart === null) dwellStart = now;
    lastOverlapAt = now;
    const progress = Math.min(1, (now - dwellStart) / DWELL_MS);
    setDwellUi(progress);
    if (progress >= 1) triggerCapture();
  } else {
    handleNoOverlap();
  }
}

function handleNoOverlap() {
  if (dwellStart === null) return;
  const now = performance.now();
  if (lastOverlapAt !== null && now - lastOverlapAt > DWELL_GRACE_MS) {
    resetDwell();
  }
}

// --- Capture flow ---

function countdown(seconds) {
  return new Promise(resolve => {
    countdownEl.classList.remove('hidden');
    let n = seconds;
    countdownEl.textContent = n;
    const timer = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(timer);
        countdownEl.classList.add('hidden');
        resolve();
      } else {
        countdownEl.textContent = n;
      }
    }, 1000);
  });
}

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

  const size = 800;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.translate(size, 0);
  ctx.scale(-1, 1); // mirror to match what the visitor saw on screen
  ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function renderResult(data, yourPhotoDataUrl) {
  tribeNameEl.textContent = data.tribe;
  tribeMetaEl.textContent = `${data.location} — ${data.year}`;
  captionEl.textContent = data.caption || data.styleNotes || '';
  creditEl.textContent = data.credit || '';

  gridEl.innerHTML = '';
  const cells = [...data.images];
  const youIndex = Math.min(5, cells.length);
  cells.splice(youIndex, 0, { you: true });

  cells.forEach(cell => {
    const wrap = document.createElement('div');
    wrap.className = 'cell';
    const img = document.createElement('img');
    if (cell.you) {
      wrap.classList.add('is-you');
      img.src = yourPhotoDataUrl;
    } else {
      img.src = cell;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
    }
    wrap.appendChild(img);
    gridEl.appendChild(wrap);
  });

  if (data.qrCodeDataUrl) {
    qrEl.src = data.qrCodeDataUrl;
    qrEl.closest('.share').classList.remove('hidden');
  } else {
    qrEl.closest('.share').classList.add('hidden');
  }

  showScreen(resultScreen);
}

const ERROR_MESSAGES = {
  rate_limited: "Our AI matcher is getting a lot of requests right now. Please wait a moment and try again.",
  source_unavailable: "Couldn't reach the Exactitudes archive just now. Please try again in a moment.",
  ai_unavailable: "Something went wrong while matching your style. Please try again.",
  no_match: "Couldn't find a clean match that time. Please try again.",
  missing_image: "That capture didn't come through. Please try again.",
  network: "Couldn't reach the server. Check the connection and try again.",
  camera: "Couldn't access the camera. Check browser permissions and reload.",
};

function renderError(errorCode) {
  errorMessageEl.textContent = ERROR_MESSAGES[errorCode] || "Something went wrong. Please try again.";
  showScreen(errorScreen);
}

function resetToIdle() {
  capturing = false;
  dwellActive = true;
  resetDwell();
  showScreen(captureScreen);
}

async function triggerCapture() {
  if (capturing) return;
  capturing = true;
  dwellActive = false;
  resetDwell();

  await countdown(COUNTDOWN_SECONDS);
  const photo = captureFrame();

  showScreen(loadingScreen);

  try {
    const res = await fetch('/api/exactitude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: photo }),
    });
    const data = await res.json();
    if (!res.ok) {
      renderError(data.error);
      return;
    }
    renderResult(data, photo);
  } catch (err) {
    console.error(err);
    renderError('network');
  }
}

againBtn.addEventListener('click', resetToIdle);
retryBtn.addEventListener('click', resetToIdle);

// Keyboard/click fallback: hand tracking is the primary trigger, but the
// button itself stays a real, focusable <button> for basic keyboard access.
captureBtn.addEventListener('click', () => { if (!capturing) triggerCapture(); });

(async function init() {
  try {
    await startCamera();
  } catch (err) {
    console.error(err);
    renderError('camera');
    return;
  }

  dwellActive = true;

  try {
    await initHandTracking();
  } catch (err) {
    console.error('Hand tracking failed to load; the capture button still works by click/tap.', err);
  }
})();
