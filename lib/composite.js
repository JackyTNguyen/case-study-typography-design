// Flattens the result screen (top bar + photo grid) into one PNG, in memory.
// Done server-side because exactitudes.com images carry no CORS headers, which
// would taint a browser canvas.
const sharp = require('sharp');
const { barHeight, tiles } = require('../public/js/layout');
const { fetchImageBuffers } = require('./exactitudes');

const LONG_SIDE = 1920;
const SANS = 'Arial, Helvetica, sans-serif';
const SERIF = "'Times New Roman', Times, serif";
const CREDIT = 'Exactitudes® by Ari Versluis & Ellie Uyttenbroek · exactitudes.com';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// Rough greedy wrap: SVG text has no automatic line breaking.
function wrap(text, fontSize, maxWidth, maxLines, charWidth = 0.5) {
  const perLine = Math.max(8, Math.floor(maxWidth / (fontSize * charWidth)));
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
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

function splitTitle(title) {
  const [, num, name] = String(title).match(/^(\d+)\.\s*(.*)$/) || [null, '', title];
  return { num, name };
}

function frame(W, B, inner) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${B}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fdf8e8"/><stop offset="1" stop-color="#fbe6ee"/></linearGradient></defs>
  <rect width="${W}" height="${B}" fill="url(#g)"/>${inner}</svg>`);
}

// Tribe name with its catalogue number as a small superscript, like the screen.
function titleSvg(lines, num, x, y0, size) {
  return lines
    .map((l, i) => {
      const y = y0 + i * size * 1.02;
      const n = i === 0 && num ? `<tspan font-size="${Math.round(size * 0.5)}" dy="${-size * 0.3}">${esc(num)}</tspan><tspan dy="${size * 0.3}"> </tspan>` : '';
      return `<text x="${x}" y="${y}" font-family="${SANS}" font-size="${size}" fill="#111">${n}${esc(l)}</text>`;
    })
    .join('');
}

// Portrait (phones, portrait kiosk): everything stacked full-width.
function barSvgPortrait(W, B, m) {
  const pad = Math.round(B * 0.1);
  const w = W - pad * 2;
  const { num, name } = splitTitle(m.tribe.title);
  const titleSize = Math.round(B * 0.15);
  const metaSize = Math.round(B * 0.07);
  const bodySize = Math.round(B * 0.066);
  const creditSize = Math.round(B * 0.052);

  const titleLines = wrap(name, titleSize, w - titleSize * 0.8, 2, 0.52);
  let y = pad + titleSize * 0.85;
  const title = titleSvg(titleLines, num, pad, y, titleSize);
  y += (titleLines.length - 1) * titleSize * 1.02 + metaSize * 1.4;
  const meta = `<text x="${pad}" y="${y}" font-family="${SANS}" font-size="${metaSize}" fill="#111">${esc(`${m.tribe.location}, ${m.tribe.year}`)}</text>`;
  const creditY = B - pad * 0.8;
  const credit = `<text x="${pad}" y="${creditY}" font-family="${SANS}" font-size="${creditSize}" fill="#444">${esc(CREDIT)}</text>`;

  const lineH = bodySize * 1.25;
  let by = y + metaSize * 0.6 + lineH;
  const available = Math.max(1, Math.floor((creditY - creditSize * 1.4 - by) / lineH) + 1);
  const ctx = wrap(m.styleDescription, bodySize, w, Math.max(1, available - 1));
  const cap = wrap(m.caption, bodySize, w, Math.max(1, available - ctx.length), 0.46);
  const body = [
    ...ctx.map((l, i) => `<text x="${pad}" y="${by + i * lineH}" font-family="${SANS}" font-size="${bodySize}" fill="#111">${esc(l)}</text>`),
    ...cap.map((l, i) => `<text x="${pad}" y="${by + (ctx.length + i) * lineH + bodySize * 0.3}" font-family="${SERIF}" font-style="italic" font-size="${bodySize}" fill="#111">${esc(l)}</text>`),
  ].join('');
  return frame(W, B, title + meta + body + credit);
}

function barSvg(W, B, m, portrait) {
  if (portrait) return barSvgPortrait(W, B, m);
  const pad = Math.round(B * 0.11);
  const leftW = Math.round(W * 0.38);
  const midX = leftW + pad;
  const midW = W - midX - pad;
  const { num, name } = splitTitle(m.tribe.title);

  const titleSize = Math.round(B * 0.2);
  const metaSize = Math.round(B * 0.095);
  const bodySize = Math.round(B * 0.088);
  const creditSize = Math.round(B * 0.07);

  const titleLines = wrap(name, titleSize, leftW - pad - titleSize * 0.8, 2, 0.52);
  let y = pad + titleSize * 0.85;
  const title = titleSvg(titleLines, num, pad, y, titleSize);
  y += (titleLines.length - 1) * titleSize * 1.02 + metaSize * 1.5;
  const meta = `<text x="${pad}" y="${y}" font-family="${SANS}" font-size="${metaSize}" fill="#111">${esc(`${m.tribe.location}, ${m.tribe.year}`)}</text>`;
  const credit = `<text x="${pad}" y="${B - pad}" font-family="${SANS}" font-size="${creditSize}" fill="#444">${esc(CREDIT)}</text>`;

  const lineH = bodySize * 1.25;
  const available = Math.floor((B - pad * 2) / lineH);
  const ctx = wrap(m.styleDescription, bodySize, midW, Math.max(1, available - 2));
  const cap = wrap(m.caption, bodySize, midW, Math.max(1, available - ctx.length - 1), 0.46);
  let my = pad + bodySize;
  const body = [
    ...ctx.map((l) => `<text x="${midX}" y="${(my += lineH) - lineH}" font-family="${SANS}" font-size="${bodySize}" fill="#111">${esc(l)}</text>`),
    ...cap.map((l, i) => `<text x="${midX}" y="${my + lineH * (i + 0.4)}" font-family="${SERIF}" font-style="italic" font-size="${bodySize}" fill="#111">${esc(l)}</text>`),
  ].join('');

  return frame(W, B, title + meta + body + credit);
}

function emptyCell(w, h) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fdf8e8"/><stop offset="1" stop-color="#fbe6ee"/></linearGradient></defs>
  <rect width="${w}" height="${h}" fill="url(#g)"/></svg>`);
}

// match: { tribe, styleDescription, caption, images[], visitorIndex }
async function composite(match, visitorJpeg, viewport) {
  const vw = Math.max(320, Number(viewport && viewport.w) || 1920);
  const vh = Math.max(320, Number(viewport && viewport.h) || 1080);
  const scale = LONG_SIDE / Math.max(vw, vh);
  const W = Math.round(vw * scale);
  const H = Math.round(vh * scale);
  const B = Math.round(barHeight(vw, vh) * scale);

  const archive = await fetchImageBuffers(match.images);
  const cells = [...archive];
  cells.splice(match.visitorIndex, 0, visitorJpeg);

  const { rects } = tiles(cells.length, vw, vh - barHeight(vw, vh));
  const gridH = H - B;
  const layers = [{ input: barSvg(W, B, match, vh > vw), left: 0, top: 0 }];

  // Snap each cell's edges to whole pixels so neighbours meet with no seams.
  const photos = await Promise.all(
    rects.map(async (r, i) => {
      const left = Math.round(r.x * W);
      const top = B + Math.round(r.y * gridH);
      const w = Math.round((r.x + r.w) * W) - left;
      const h = B + Math.round((r.y + r.h) * gridH) - top;
      const buf = cells[i];
      let input;
      try {
        input = buf
          ? await sharp(buf).rotate().resize(w, h, { fit: 'cover', position: 'centre' }).toBuffer()
          : emptyCell(w, h); // only if a single archive image failed to download
      } catch {
        input = emptyCell(w, h);
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
