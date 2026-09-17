// public/chartGeometry.js
//
// The arithmetic that decides whether a chart is readable.
//
// Split out of charts.js so it can be unit tested: the d3 drawing can only be
// checked by eye, but "is there enough room for these rows" is the thing that
// actually went wrong -- every chart used to be drawn at min(width * 0.72,
// 260) whatever it held, so a fifteen-row bar chart got eleven pixels a row.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ChartGeometry = api;
})(this, function () {
  // Enough for a category label at 11px plus the padding between bars.
  const ROW_HEIGHT = 28;
  const MIN_HEIGHT = 120;
  // Below this a direct value label collides with its neighbour, and the chart
  // has to grow an axis instead.
  const MIN_BAND_FOR_LABELS = 22;
  // Average glyph width at the 11px label size, measured from the existing CSS.
  const CHAR_PX = 6.2;

  function heightFor(type, rowCount, width, maxHeight) {
    const rows = Math.max(1, Number(rowCount) || 1);
    let height;

    switch (type) {
      case "card":
        return 120;
      case "bar":
      case "variance":
        // Structure charts grow downwards: there is no reason a category list
        // should be squeezed to fit a box.
        height = rows * ROW_HEIGHT + 24;
        break;
      case "line":
        height = width * 0.5;
        break;
      case "donut":
        height = Math.max(width * 0.55, rows * 18 + 24);
        break;
      default:
        // column, and anything unrecognised
        height = width * 0.62;
    }

    return Math.min(Math.max(Math.round(height), MIN_HEIGHT), maxHeight);
  }

  function labelsFit(bandSize) {
    return Number(bandSize) >= MIN_BAND_FOR_LABELS;
  }

  function truncateLabel(text, maxWidthPx) {
    const s = String(text ?? "");
    const max = Math.max(1, Math.floor(Number(maxWidthPx) / CHAR_PX));
    if (s.length <= max) return s;
    return s.slice(0, Math.max(1, max - 1)) + "…";
  }

  return { heightFor, labelsFit, truncateLabel, ROW_HEIGHT };
});
