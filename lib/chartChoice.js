const BUDGETS = require("./budgets");

// Picks the chart type from the rows a query actually returned.
//
// This used to be left entirely to the model, via a prompt that listed the
// available types — and listed "bar" twice with two different meanings. The
// result was inconsistent: the same question could come back as a column one
// time and a pie the next, because nothing in the prompt decided it.
//
// The facts that decide it are all in the result set: how many rows there are,
// how many numeric columns each row carries, and whether the category being
// plotted is a period or a thing. So the unambiguous cases are settled here,
// in code, where they can be unit-tested and can't drift. The model still
// chooses in the genuinely judgement-based cases — is this question about a
// share of a whole, or about a change? — because that depends on what was
// asked, not on the shape of the data.
//
// The rule underneath all of it is the IBCS one: vertical is for time,
// horizontal is for structure. Never both for the same data.

// Detection is by column name first — 'Date'[Year] is unambiguous — and by the
// values only as a fallback, because a column of 2014-2016 is a time axis
// whatever it happens to be called.
const TEMPORAL_NAME = /\b(year|yr|quarter|qtr|month|week|day|date|period|fiscal)\b/i;
const MONTH_NAME = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const YEAR_VALUE = /^(19|20)\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?/;

// The model tells us what the question is ABOUT; the rows tell us what can
// honestly be drawn. This used to be two regexes over the question text, which
// guessed at the same thing with far less to go on.
const INTENTS = new Set(["share", "change", "trend", "ranking", "single"]);

const MAX_DONUT_SLICES = 6;
// Past this many categories a vertical column chart's labels collide and a
// horizontal bar is simply readable where a column is not.
const MAX_COLUMNS_ON_AXIS = 12;
// A trend needs enough points to have a shape; below this the individual
// values are the message and columns show them better.
const MIN_POINTS_FOR_LINE = 7;

function isNumeric(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Power BI returns rows keyed by qualified name: "Data[Genre]", "[Total Sales]".
function columnsOf(rows) {
  const keys = [];
  for (const row of rows) {
    for (const k of Object.keys(row || {})) if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

function isTemporal(key, rows) {
  if (TEMPORAL_NAME.test(key)) return true;

  const values = rows
    .map((r) => r?.[key])
    .filter((v) => v !== null && v !== undefined)
    .slice(0, 12);
  if (!values.length) return false;

  return values.every((v) => {
    const s = String(v).trim();
    return YEAR_VALUE.test(s) || ISO_DATE.test(s) || MONTH_NAME.test(s);
  });
}

// A column counts as numeric only if every non-null value in it is a number —
// one stray string means it is a label, not a measure.
function classify(rows) {
  const numeric = [];
  const categorical = [];

  for (const key of columnsOf(rows)) {
    const values = rows.map((r) => r?.[key]).filter((v) => v !== null && v !== undefined);
    if (values.length && values.every(isNumeric)) numeric.push(key);
    else categorical.push(key);
  }
  return { numeric, categorical };
}

/**
 * Returns { type, reason, fixed }.
 *
 * `fixed` marks the cases with exactly one right answer, where the model's
 * suggestion is overridden rather than consulted. A query returning a single
 * number is a card however the question was phrased; making that negotiable is
 * how a single value ends up drawn as a pie.
 */
function chooseChartType(question, rows, intent) {
  const data = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const hint = INTENTS.has(intent) ? intent : null;

  if (!data.length) return { type: null, reason: "no rows returned", fixed: true };

  const { numeric, categorical } = classify(data);

  if (!numeric.length) {
    return { type: null, reason: "no numeric column to plot", fixed: true };
  }

  // One number, nothing to compare it against.
  if (data.length === 1 && numeric.length === 1) {
    return { type: "card", reason: "a single value", fixed: true };
  }

  const category = categorical.find((key) => isTemporal(key, data)) || categorical[0];
  const temporal = Boolean(category) && isTemporal(category, data);

  // Time wins over the multi-measure rule while there are few enough measures
  // to plot as series. "Sales by year" returning an actual and a prior year is
  // the textbook two-series line — routing it to a table because it has two
  // numbers per row throws away the shape, which is the entire message.
  // Past two measures there is nothing a single chart can honestly show.
  // Row count doesn't matter here: a single row carrying three measures is
  // still three numbers, and routing it to a bar silently drops two of them.
  if (numeric.length >= 2 && !(temporal && numeric.length <= 2)) {
    return {
      type: "table",
      reason: `${numeric.length} measures per row`,
      fixed: true,
    };
  }

  if (temporal) {
    // Vertical is for time. Which vertical form depends only on how many
    // points there are: enough of them and the line's shape carries more than
    // the individual values do.
    return data.length >= MIN_POINTS_FOR_LINE
      ? { type: "line", reason: `${data.length} points over time`, fixed: true }
      : { type: "column", reason: `${data.length} periods`, fixed: true };
  }

  // Structure. Beyond this point the question's intent matters, so the model's
  // hint is consulted -- but only here, where the rows genuinely permit more
  // than one honest answer.
  if (hint === "change") {
    return { type: "variance", reason: "the question is about a change", fixed: false };
  }

  if (hint === "share" && data.length <= MAX_DONUT_SLICES) {
    return { type: "donut", reason: `${data.length} parts of a whole`, fixed: false };
  }

  return {
    type: "bar",
    reason:
      data.length > MAX_COLUMNS_ON_AXIS
        ? `${data.length} categories — too many for a vertical axis`
        : "a measure across categories",
    fixed: data.length > MAX_COLUMNS_ON_AXIS,
  };
}

// Power BI returns "Data[Genre]" / "[Total Sales]"; the brackets are wiring,
// not something to show a person.
function prettyName(key) {
  const inner = String(key).match(/\[([^\]]+)\]\s*$/);
  return (inner ? inner[1] : String(key)).trim();
}

/**
 * Builds the chart spec straight from the rows.
 *
 * This was the model's job for one afternoon and it emitted the spec on about
 * one reply in three — it was already being asked for prose, a chart line and a
 * follow-ups line, and it reliably dropped one of them however the instruction
 * was worded. Mapping rows to {labels, values} is mechanical, so there is
 * nothing for a model to contribute and nothing for it to get wrong.
 *
 * Returns null when the rows don't make a chart.
 */
function buildChartSpec(question, rows, options = {}) {
  const { intent, caption, format } = typeof options === "string" ? { caption: options } : options;
  const data = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const choice = chooseChartType(question, data, intent);
  if (!choice.type) return null;

  const { numeric, categorical } = classify(data);
  const category = categorical.find((key) => isTemporal(key, data)) || categorical[0];
  const label = caption || (numeric.length ? prettyName(numeric[0]) : "");

  if (choice.type === "card") {
    return { type: "card", values: [data[0][numeric[0]]], label, ...(format ? { format } : {}) };
  }

  if (choice.type === "table") {
    // Every column, in the order the query returned them — for a table the
    // values themselves are the point, so nothing is dropped. A table can
    // mix a percentage measure with an ordinary one, so a single spec-level
    // format flag would misdescribe half its columns -- percent formatting
    // is deliberately not applied here.
    const keys = [...(category ? [category] : []), ...numeric];
    return {
      type: "table",
      label,
      columns: keys.map(prettyName),
      rows: data.map((r) => keys.map((k) => r[k])),
    };
  }

  if (!category) return null;

  // Past this many categories a bar chart is unreadable at any height, so show
  // the ones that carry the story and say what was left out. A timeline is
  // never reordered or cut -- the gap would read as a real gap in the data.
  const temporal = isTemporal(category, data);
  let plotted = data;
  let truncated;
  // The full, untruncated pairs travel alongside the chart under a separate
  // key so a CSV download can carry every category — the chart itself keeps
  // showing only the top slice, because the readability limit is real.
  let full;
  if (!temporal && data.length > BUDGETS.CHART_MAX_CATEGORIES) {
    const measure = numeric[0];
    plotted = [...data]
      .sort((a, b) => (Number(b[measure]) || 0) - (Number(a[measure]) || 0))
      .slice(0, BUDGETS.CHART_TRUNCATE_TO);
    truncated = { shown: plotted.length, total: data.length };
    full = {
      labels: data.map((r) => String(r[category])),
      values: data.map((r) => r[numeric[0]]),
    };
  }

  const labels = plotted.map((r) => String(r[category]));

  // Two measures over time is the IBCS two-series case: actual against its
  // comparison, not two unrelated lines.
  if (numeric.length >= 2) {
    return {
      type: choice.type,
      label,
      labels,
      series: numeric.slice(0, 2).map((key, i) => ({
        name: prettyName(key),
        scenario: i === 0 ? "AC" : "PY",
        values: plotted.map((r) => r[key]),
      })),
      ...(truncated ? { truncated, full } : {}),
      ...(format ? { format } : {}),
    };
  }

  return {
    type: choice.type,
    label,
    labels,
    values: plotted.map((r) => r[numeric[0]]),
    ...(truncated ? { truncated, full } : {}),
    ...(format ? { format } : {}),
  };
}

/**
 * The chart types that can honestly render these rows. Used by the browser's
 * type switcher, so a user can never pick a form the data does not support --
 * a line over unordered categories implies an order that is not there.
 */
function validTypesFor(rows) {
  const data = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!data.length) return [];

  const { numeric, categorical } = classify(data);
  if (!numeric.length) return [];

  if (data.length === 1 && numeric.length === 1) return ["card", "table"];

  const category = categorical.find((key) => isTemporal(key, data)) || categorical[0];
  if (!category) return ["table"];

  const types = ["bar", "table"];
  if (isTemporal(category, data)) types.push("column", "line");
  else if (data.length <= MAX_COLUMNS_ON_AXIS) types.push("column");

  if (data.length <= MAX_DONUT_SLICES) types.push("donut");
  if (numeric.length >= 2) types.push("variance");

  return types;
}

module.exports = { chooseChartType, buildChartSpec, validTypesFor, classify, isTemporal, prettyName };
