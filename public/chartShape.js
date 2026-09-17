// public/chartShape.js
//
// Reconciles a chart spec with the type it is being drawn as.
//
// buildChartSpec emits genuinely different key shapes for different types --
// {labels, values} or {labels, series} for a bar, {columns, rows} for a table,
// {values: [x], label} for a card -- while validTypesFor classifies the ROWS,
// so the type switcher can honestly offer a bar for rows that were built as a
// table. Swapping spec.type alone then handed the bar renderer a spec with no
// labels and no values, and the render guard blanked the figure with no error.
//
// So the translation happens here, at the render layer, rather than by taking
// the alternatives away: a two-column table really can be drawn as a bar once
// its labels and values are read out of columns/rows.
//
// Split out of charts.js, like chartGeometry, so it can be unit tested --
// this exact class of defect (a client-only change with nowhere to test it)
// is what let the blank figure through.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.ChartShape = api;
})(this, function () {
  // Every type whose renderer reads labels + values/series.
  const PLOTTED = new Set(["bar", "column", "line", "donut", "pie", "variance", "card"]);

  function isNum(v) {
    return typeof v === "number" && Number.isFinite(v);
  }

  function blank(v) {
    return v === null || v === undefined;
  }

  function points(spec) {
    const raw = spec.values || spec.data;
    return Array.isArray(raw) ? raw : null;
  }

  /**
   * Returns a spec of `targetType` whose keys the matching renderer can read,
   * derived from whichever shape the spec actually holds. The original is
   * returned untouched when it already fits, and also for the residual cases
   * that genuinely cannot be reconciled (a table of three or more measures has
   * no honest single-chart form) -- there the caller's empty-render guard is
   * still the right answer.
   */
  function deriveRenderable(spec, targetType) {
    if (!spec || typeof spec !== "object") return spec;

    const type = targetType || spec.type;
    const out = { ...spec, type };

    const labels = Array.isArray(spec.labels) && spec.labels.length ? spec.labels : null;
    const series = Array.isArray(spec.series) && spec.series.length ? spec.series : null;
    const values = points(spec);
    const rows = Array.isArray(spec.rows) && spec.rows.length ? spec.rows : null;

    if (type === "table") {
      if (rows) return out;
      if (labels && (values || series)) return out; // renderTable builds these itself
      // A card: one figure and no categories at all, so there is nothing for
      // the label column to hold but the measure's own name.
      if (values && values.length) {
        return { ...out, columns: [spec.label || "Value"], rows: [[values[0]]] };
      }
      return out;
    }

    if (!PLOTTED.has(type)) return out;
    if (labels && (values || series)) return out;

    // A card being drawn as a chart: its one value becomes its one bar, named
    // by the caption the card would otherwise have shown.
    if (!rows && values && values.length) {
      return { ...out, labels: [spec.label || "Total"] };
    }
    if (!rows) return out;

    const columns = Array.isArray(spec.columns) ? spec.columns : [];
    const first = rows.map((r) => r[0]);
    // With no categorical first column there is nothing to put on the axis.
    if (first.every(isNum)) return out;

    const measures = [];
    for (let c = 1; c < columns.length; c += 1) {
      const column = rows.map((r) => r[c]);
      if (column.every((v) => blank(v) || isNum(v))) {
        measures.push({ name: columns[c], values: column });
      }
    }

    // Three or more measures cannot go on one chart without silently picking
    // one of them, which is worse than not drawing it.
    if (!measures.length || measures.length > 2) return out;

    const derivedLabels = first.map(String);
    if (measures.length === 1) {
      return {
        ...out,
        labels: derivedLabels,
        values: measures[0].values,
        label: spec.label || measures[0].name,
      };
    }

    return {
      ...out,
      labels: derivedLabels,
      series: measures.map((m, i) => ({
        name: m.name,
        scenario: i === 0 ? "AC" : "PY",
        values: m.values,
      })),
    };
  }

  return { deriveRenderable };
});
