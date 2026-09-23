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

  // Pick columns/rows so n uniform cells fill W x H edge to edge, preferring
  // near-square (or slightly portrait) cells and as few empty slots as possible.
  function grid(n, W, H) {
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const empties = rows * cols - n;
      if (empties >= cols) continue; // a fully empty row is never right
      const aspect = W / cols / (H / rows);
      const skew = Math.log(aspect);
      // Landscape cells crop heads and feet off full-length portraits, so punish them harder.
      const score = (skew > 0 ? skew * 1.6 : -skew) + empties * 0.5;
      if (!best || score < best.score) best = { cols, rows, empties, score };
    }
    return best;
  }

  return { barHeight, grid };
});
