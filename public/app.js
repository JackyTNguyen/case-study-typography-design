const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const startBtn = document.getElementById('startBtn');
const againBtn = document.getElementById('againBtn');
const countdownEl = document.getElementById('countdown');

const captureScreen = document.getElementById('captureScreen');
const loadingScreen = document.getElementById('loadingScreen');
const resultScreen = document.getElementById('resultScreen');

const tribeNameEl = document.getElementById('tribeName');
const tribeMetaEl = document.getElementById('tribeMeta');
const captionEl = document.getElementById('caption');
const gridEl = document.getElementById('grid');
const creditEl = document.getElementById('credit');

let stream = null;

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 720, height: 720 }, audio: false });
  video.srcObject = stream;
}

function showScreen(el) {
  [captureScreen, loadingScreen, resultScreen].forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

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
  const size = 720;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // mirror to match the preview
  ctx.translate(size, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function renderResult(data, yourPhotoDataUrl) {
  tribeNameEl.textContent = data.tribe;
  tribeMetaEl.textContent = `${data.location} — ${data.year}`;
  captionEl.textContent = data.caption || data.styleNotes || '';
  creditEl.textContent = data.credit || '';

  gridEl.innerHTML = '';

  const cells = [...data.images];
  // insert the visitor roughly in the middle of the grid, not always slot 1
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

  showScreen(resultScreen);
}

async function runCapture() {
  await countdown(3);
  const photo = captureFrame();

  showScreen(loadingScreen);

  try {
    const res = await fetch('/api/exactitude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: photo }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    renderResult(data, photo);
  } catch (err) {
    console.error(err);
    alert('Could not build your Exactitude. Check the server logs / API key and try again.');
    showScreen(captureScreen);
  }
}

startBtn.addEventListener('click', runCapture);
againBtn.addEventListener('click', () => showScreen(captureScreen));

startCamera().catch(err => {
  console.error(err);
  alert('Could not access the camera. Check browser permissions.');
});
