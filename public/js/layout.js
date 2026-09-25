// Shared by the kiosk (result screen) and the server (downloadable PNG), so
// the image a visitor takes home has exactly the layout shown on screen.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MirrorLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const isPortrait = (W, H) => H > W;

  // Height of the top bar. Portrait screens get a taller bar relative to their
  // width so the stacked text stays readable from standing distance.
  function barHeight(W, H) {
    const h = isPortrait(W, H) ? Math.min(H * 0.2, W * 0.34) : Math.min(H * 0.26, W * 0.2);
    return Math.round(Math.max(170, h));
  }

  // Tile n photos over W x H with no gaps and no empty slots. Photos are split
  // over columns that each run the full height; when n doesn't divide evenly,
  // some columns hold one photo fewer and their cells get a little taller.
  // Taller cells only trim the sides of a full-length portrait, never heads or
  // feet, which is why columns absorb the difference rather than rows.
  // Rects are fractions (0-1) of the area, filled column by column.
  function tiles(n, W, H) {
    const penalty = (w, h) => {
      const skew = Math.log(w / h);
      return skew > 0 ? skew * 1.6 : -skew; // wide cells crop heads and feet
    };
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const base = Math.floor(n / cols);
      const extra = n % cols; // columns holding base + 1 photos
      const cw = W / cols;
      const score =
        (extra * (base + 1) * penalty(cw, H / (base + 1)) + (cols - extra) * base * penalty(cw, H / base)) / n +
        (extra ? 0.08 : 0); // mild preference for a perfectly even grid
      if (!best || score < best.score) best = { cols, base, extra, score };
    }

    const { cols, base, extra } = best;
    const rects = [];
    for (let c = 0; c < cols; c++) {
      // Spread the fuller columns evenly across the width.
      const full = Math.floor(((c + 1) * extra) / cols) > Math.floor((c * extra) / cols);
      const count = base + (full ? 1 : 0);
      for (let r = 0; r < count; r++) rects.push({ x: c / cols, y: r / count, w: 1 / cols, h: 1 / count });
    }
    return { cols, rects };
  }

  // Where to draw the visitor's (centred) square photo inside a w x h cell.
  // Like object-fit: cover, so it matches the archive portraits, unless that
  // would crop the person (box = their size as a fraction of the square); then
  // it shrinks just enough to show all of them. The photo's flat grey matches
  // the cell's grey, so any leftover space is invisible.
  function fitVisitor(w, h, box, margin = 0.04) {
    let size = Math.max(w, h);
    if (box) size = Math.min(size, w / Math.min(1, box.w + margin), h / Math.min(1, box.h + margin));
    return { size, x: (w - size) / 2, y: (h - size) / 2 };
  }

  return { isPortrait, barHeight, tiles, fitVisitor };
});
