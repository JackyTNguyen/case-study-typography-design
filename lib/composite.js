// Flattens the result screen (top bar + photo grid) into one PNG, in memory.
// Server-side because exactitudes.com images carry no CORS headers, which
// would taint a browser canvas and block exporting it.
const sharp = require('sharp');
const { isPortrait, barHeight, tiles } = require('../public/js/layout');
const { fetchImageBuffers } = require('./exactitudes');

const LONG_SIDE = 1920;
const SANS = 'Arial, Helvetica, sans-serif';
const SERIF = "'Times New Roman', Times, serif";
const ARCHIVE_GREY = '#F3F3F3'; // the exactitudes.com background
const CREDIT = 'Exactitudes® by Ari Versluis & Ellie Uyttenbroek · exactitudes.com';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// SVG has no line wrapping, so wrap greedily on an estimated character width.
function wrap(text, size, maxWidth, maxLines, charWidth = 0.5) {
  const perLine = Math.max(8, Math.floor(maxWidth / (size * charWidth)));
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > perLine && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = Math.max(1, maxLines);
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

const text = (x, y, size, content, { font = SANS, fill = '#111', italic = false } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" fill="${fill}"${italic ? ' font-style="italic"' : ''}>${content}</text>`;

// "197. Architects": catalogue number as a small superscript, like the screen.
function title(m, x, y, size) {
  const [, num, name] = String(m.tribe.title).match(/^(\d+)\.\s*(.*)$/) || [null, '', m.tribe.title];
  const sup = num
    ? `<tspan font-size="${Math.round(size * 0.5)}" dy="${-size * 0.32}">${esc(num)}</tspan><tspan dy="${size * 0.32}"> </tspan>`
    : '';
  return text(x, y, size, sup + esc(name));
}

function bodyLines(m, size, width, maxLines) {
  const ctx = wrap(m.styleDescription, size, width, Math.max(1, maxLines - 1));
  const cap = wrap(m.caption, size, width, Math.max(1, maxLines - ctx.length), 0.46);
  return { ctx, cap };
}

function bar(W, B, m, portrait) {
  const lineOf = (s) => s * 1.25;
  let inner = '';

  if (portrait) {
    // Stacked: name, place/year, credit, then context + caption full width.
    const pad = Math.round(B * 0.09);
    const t = Math.round(B * 0.16);
    const meta = Math.round(B * 0.075);
    const credit = Math.round(B * 0.052);
    const body = Math.round(B * 0.07);
    let y = pad + t * 0.85;
    inner += title(m, pad, y, t);
    y += meta * 1.45;
    inner += text(pad, y, meta, esc(`${m.tribe.location}, ${m.tribe.year}`));
    y += credit * 1.7;
    inner += text(pad, y, credit, esc(CREDIT), { fill: '#444' });
    y += body * 1.6;
    const maxLines = Math.max(2, Math.floor((B - pad - y) / lineOf(body)) + 1);
    const { ctx, cap } = bodyLines(m, body, W - pad * 2, maxLines);
    ctx.forEach((l, i) => (inner += text(pad, y + i * lineOf(body), body, esc(l))));
    cap.forEach((l, i) => (inner += text(pad, y + (ctx.length + i) * lineOf(body) + body * 0.3, body, esc(l), { font: SERIF, italic: true })));
  } else {
    // Landscape: name/place/credit on the left, context + caption beside it.
    const pad = Math.round(B * 0.11);
    const leftW = Math.round(W * 0.38);
    const t = Math.round(B * 0.2);
    const meta = Math.round(B * 0.095);
    const credit = Math.round(B * 0.068);
    const body = Math.round(B * 0.088);
    inner += title(m, pad, pad + t * 0.85, t);
    inner += text(pad, pad + t * 0.85 + meta * 1.5, meta, esc(`${m.tribe.location}, ${m.tribe.year}`));
    inner += text(pad, B - pad, credit, esc(CREDIT), { fill: '#444' });
    const x = leftW + pad;
    const maxLines = Math.floor((B - pad * 2) / lineOf(body));
    const { ctx, cap } = bodyLines(m, body, W - x - pad, maxLines);
    const y0 = pad + body;
    ctx.forEach((l, i) => (inner += text(x, y0 + i * lineOf(body), body, esc(l))));
    cap.forEach((l, i) => (inner += text(x, y0 + (ctx.length + i) * lineOf(body) + body * 0.4, body, esc(l), { font: SERIF, italic: true })));
  }

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${B}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fdf8e8"/><stop offset="1" stop-color="#fbe6ee"/></linearGradient></defs>
  <rect width="${W}" height="${B}" fill="url(#g)"/>${inner}</svg>`);
}

const greyCell = (w, h) => ({ create: { width: w, height: h, channels: 3, background: ARCHIVE_GREY } });

// match: { tribe, styleDescription, caption, images[], visitorIndex }
// visitor: Buffer (the cut-out, or the original photo as fallback)
async function composite(match, visitor, viewport) {
  const vw = Math.max(200, Number(viewport && viewport.w) || 1080);
  const vh = Math.max(200, Number(viewport && viewport.h) || 1920);
  const scale = LONG_SIDE / Math.max(vw, vh);
  const W = Math.round(vw * scale);
  const H = Math.round(vh * scale);
  const B = Math.round(barHeight(vw, vh) * scale);
  const gridH = H - B;

  const cells = await fetchImageBuffers(match.images);
  cells.splice(match.visitorIndex, 0, visitor);
  const { rects } = tiles(cells.length, vw, vh - barHeight(vw, vh));

  const layers = [{ input: bar(W, B, match, isPortrait(vw, vh)), left: 0, top: 0 }];
  const photos = await Promise.all(
    rects.map(async (r, i) => {
      // Snap edges to whole pixels so neighbouring cells meet without seams.
      const left = Math.round(r.x * W);
      const top = B + Math.round(r.y * gridH);
      const w = Math.round((r.x + r.w) * W) - left;
      const h = B + Math.round((r.y + r.h) * gridH) - top;
      let input;
      try {
        input = cells[i]
          ? await sharp(cells[i]).rotate().resize(w, h, { fit: 'cover', position: 'centre' }).toBuffer()
          : await sharp(greyCell(w, h)).png().toBuffer();
      } catch {
        input = await sharp(greyCell(w, h)).png().toBuffer();
      }
      return { input, left, top };
    })
  );
  layers.push(...photos);

  return sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
    .composite(layers)
    .png({ compressionLevel: 8 })
    .toBuffer();
}

module.exports = { composite, CREDIT };
