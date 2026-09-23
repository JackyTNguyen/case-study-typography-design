// Optional: download MediaPipe's hand landmark model so the kiosk doesn't need
// Google's CDN at runtime. The frontend falls back to the CDN if this is absent.
const fs = require('fs');
const path = require('path');

const URL_ = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const OUT = path.join(__dirname, '..', 'public', 'models', 'hand_landmarker.task');

(async () => {
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(await res.arrayBuffer()));
  console.log(`Saved ${path.relative(process.cwd(), OUT)}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
