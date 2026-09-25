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
// Where the models sit in the archive portraits, measured on 30 photos from 10
// series (1994-2025): head 6% from the top, feet at 99%, figure 93% of the
// frame's height, centred. The spread was small (top 4-7%, height 92-95%).
const ARCHIVE_FRAME = { top: 0.06, bottom: 0.99, centreX: 0.5 };
const MAX_UPSCALE = 2.5; // beyond this a far-away visitor would turn to mush

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

// The person's extent in the mask, as fractions of the frame. Uses the 1st-99th
// percentile of mask weight per axis, so stray specks don't stretch the box.
function personBox(fg, w, h) {
  const cols = new Float32Array(w);
  const rows = new Float32Array(h);
  let total = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = fg[y * w + x];
      cols[x] += v;
      rows[y] += v;
      total += v;
    }
  }
  const range = (hist) => {
    let acc = 0;
    let lo = 0;
    let hi = hist.length - 1;
    for (let i = 0; i < hist.length; i++) if ((acc += hist[i]) >= total * 0.01) { lo = i; break; }
    acc = 0;
    for (let i = hist.length - 1; i >= 0; i--) if ((acc += hist[i]) >= total * 0.01) { hi = i; break; }
    return [lo / hist.length, (hi + 1) / hist.length];
  };
  const [x0, x1] = range(cols);
  const [y0, y1] = range(rows);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// photo: a square canvas holding the captured frame.
// Resolves to a JPEG data URL with the person framed exactly like the archive
// portraits, or null if there's no usable person mask (the caller then uses
// the original photo).
export async function cutOut(photo, quality = 0.9) {
  if (!segmenter) return null;
  const size = photo.width;

  // Foreground alpha = 1 - background confidence, eased so faint background
  // noise drops out while soft hair edges stay soft.
  let mask = null;
  let coverage = 0;
  let box = null;
  segmenter.segment(photo, (result) => {
    const bg = result.confidenceMasks && result.confidenceMasks[0];
    if (!bg) return;
    const w = bg.width;
    const h = bg.height;
    const conf = bg.getAsFloat32Array();
    const data = new ImageData(w, h);
    const fg = new Float32Array(conf.length);
    let sum = 0;
    for (let i = 0; i < conf.length; i++) {
      fg[i] = Math.min(1, Math.max(0, (1 - conf[i] - 0.2) / 0.6)); // smoothstep-ish 0.2..0.8
      sum += fg[i];
      data.data[i * 4 + 3] = Math.round(fg[i] * 255);
    }
    coverage = sum / conf.length;
    box = personBox(fg, w, h);
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

  // ...scaled and moved so they're framed like the archive models, on the
  // archive grey. The grey is flat, so moving leaves no seam.
  const { k, dx, dy } = archiveFraming(box, size);
  const out = new OffscreenCanvas(size, size);
  const oc = out.getContext('2d');
  oc.fillStyle = ARCHIVE_GREY;
  oc.fillRect(0, 0, size, size);
  oc.drawImage(person, dx, dy, size * k, size * k);

  const blob = await out.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Scale k and offset (dx, dy) that put the person's head at ARCHIVE_FRAME.top,
// their feet at ARCHIVE_FRAME.bottom, and their middle at centreX.
// If the camera cut off their feet (or head), their full height is unknown, so
// the size is kept and only the visible end is lined up with the archive.
function archiveFraming(box, size) {
  const feetCut = box.y + box.h > 0.97;
  const headCut = box.y < 0.01;
  let k = 1;
  if (!feetCut && !headCut) k = (ARCHIVE_FRAME.bottom - ARCHIVE_FRAME.top) / box.h;
  k = Math.min(MAX_UPSCALE, Math.max(0.3, k));

  const dx = (ARCHIVE_FRAME.centreX - (box.x + box.w / 2) * k) * size;
  const dy = headCut && !feetCut
    ? (ARCHIVE_FRAME.bottom - (box.y + box.h) * k) * size // line up the feet
    : (ARCHIVE_FRAME.top - box.y * k) * size; // line up the head
  return { k, dx, dy };
}
