// Downloads the two MediaPipe models the kiosk runs in the browser into
// public/models/, so the installation doesn't depend on Google's CDN at
// runtime. The frontend falls back to the CDN if a file is missing.
const fs = require('fs');
const path = require('path');

const MODELS = {
  'hand_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};
const DIR = path.join(__dirname, '..', 'public', 'models');

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  for (const [file, url] of Object.entries(MODELS)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${file}: download failed (${res.status})`);
    fs.writeFileSync(path.join(DIR, file), Buffer.from(await res.arrayBuffer()));
    console.log(`Saved public/models/${file}`);
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
