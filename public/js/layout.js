// Shared by the browser (result screen) and the server (PNG composite) so the
// downloaded image has the same grid as the screen.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MirrorLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Top bar height for a given viewport. Portrait screens (the intended kiosk
  // orientation) get a taller bar relative to their width so the text stays
  // readable from standing distance.
  function barHeight(W, H) {
    const byWidth = W < H ? W * 0.3 : W * 0.2;
    return Math.round(Math.max(170, Math.min(H * 0.26, byWidth)));
  }

  // Tile n photos over a W x H area with no gaps and no empty slots. Photos are
  // split over columns that each run the full height; when n doesn't divide
  // evenly, some columns hold one photo fewer, so their cells are a bit taller.
  // Taller (portrait) cells only trim the sides of a full-length portrait,
  // never heads or feet, which is why columns absorb the difference, not rows.
  // Returns rects as fractions of the area (0-1), filled column by column.
  function tiles(n, W, H) {
    const penalty = (w, h) => {
      const skew = Math.log(w / h);
      return skew > 0 ? skew * 1.6 : -skew; // landscape cells crop heads/feet
    };
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const base = Math.floor(n / cols);
      const extra = n % cols; // columns that get base + 1 photos
      const cw = W / cols;
      let score = extra * (base + 1) * penalty(cw, H / (base + 1));
      score += (cols - extra) * base * penalty(cw, H / base);
      score = score / n + (extra ? 0.08 : 0); // slight preference for a perfectly even grid
      if (!best || score < best.score) best = { cols, base, extra, score };
    }

    const { cols, base, extra } = best;
    const rects = [];
    for (let c = 0; c < cols; c++) {
      // Spread the fuller columns evenly across the width.
      const full = Math.floor(((c + 1) * extra) / cols) > Math.floor((c * extra) / cols);
      const count = base + (full ? 1 : 0);
      for (let r = 0; r < count; r++) {
        rects.push({ x: c / cols, y: r / count, w: 1 / cols, h: 1 / count });
      }
    }
    return { cols, rects };
  }

  return { barHeight, tiles };
});
