// Background removal, entirely in the browser: MediaPipe's multiclass selfie
// segmenter. Everything that isn't class 0 ("background") is kept, so hair,
// clothes and accessories (hats, bags, jewellery) survive. The person is
// drawn onto flat #F3F3F3, the exactitudes.com background.
import { ImageSegmenter } from '/vendor/mediapipe/vision_bundle.mjs';

const MODEL_LOCAL = '/models/selfie_multiclass_256x256.tflite';
const MODEL_CDN =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';
const ARCHIVE_GREY = '#F3F3F3';
const EDGE_BLUR_PX = 1.5; // softens hair and sleeve edges
const MIN_PERSON = 0.03; // below 3% of the frame: nobody there, use the original

let segmenter = null;

export async function loadSegmenter(fileset) {
  const local = await fetch(MODEL_LOCAL, { method: 'HEAD' }).then((r) => r.ok, () => false);
  const make = (delegate) =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: local ? MODEL_LOCAL : MODEL_CDN, delegate },
      runningMode: 'IMAGE',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
  try {
    segmenter = await make('GPU');
  } catch {
    segmenter = await make('CPU');
  }
  // The first inference compiles GPU shaders and takes seconds; do it now, on a
  // blank frame, so the visitor's capture gets the fast path.
  // Same size as a real capture, so nothing gets rebuilt on the first visitor.
  const blank = new OffscreenCanvas(768, 768);
  blank.getContext('2d').fillRect(0, 0, 768, 768);
  segmenter.segment(blank, () => {});
}

export const segmenterReady = () => Boolean(segmenter);

// photo: a square canvas holding the captured frame.
// Resolves to a JPEG data URL of the cut-out, or null if there's no usable
// person mask (the caller then uses the original photo).
export async function cutOut(photo, quality = 0.9) {
  if (!segmenter) return null;
  const size = photo.width;

  // Foreground alpha = 1 - background confidence, eased so faint background
  // noise drops out while soft hair edges stay soft.
  let mask = null;
  let coverage = 0;
  segmenter.segment(photo, (result) => {
    const bg = result.confidenceMasks && result.confidenceMasks[0];
    if (!bg) return;
    const w = bg.width;
    const h = bg.height;
    const conf = bg.getAsFloat32Array();
    const data = new ImageData(w, h);
    let sum = 0;
    for (let i = 0; i < conf.length; i++) {
      const fg = Math.min(1, Math.max(0, (1 - conf[i] - 0.2) / 0.6)); // smoothstep-ish 0.2..0.8
      sum += fg;
      data.data[i * 4 + 3] = Math.round(fg * 255);
    }
    coverage = sum / conf.length;
    mask = new OffscreenCanvas(w, h);
    mask.getContext('2d').putImageData(data, 0, 0);
  });
  if (!mask || coverage < MIN_PERSON) return null;

  // The person, masked with a slightly blurred edge.
  const person = new OffscreenCanvas(size, size);
  const pc = person.getContext('2d');
  pc.drawImage(photo, 0, 0);
  pc.globalCompositeOperation = 'destination-in';
  pc.filter = `blur(${EDGE_BLUR_PX}px)`;
  pc.drawImage(mask, 0, 0, size, size);

  // ...placed on the archive grey.
  const out = new OffscreenCanvas(size, size);
  const oc = out.getContext('2d');
  oc.fillStyle = ARCHIVE_GREY;
  oc.fillRect(0, 0, size, size);
  oc.drawImage(person, 0, 0);

  const blob = await out.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
