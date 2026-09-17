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

// Questions about a share of a whole, and questions about a movement. Both are
// about what was asked rather than what came back, so both are hints rather
// than rules.
const SHARE_QUESTION = /\b(share|split|breakdown|proportion|percentage of|mix|composition|make up|made up)\b/i;
const CHANGE_QUESTION = /\b(change|growth|decline|difference|gap|variance|versus|vs\.?|compared? (?:to|with)|year[- ]on[- ]year|yoy)\b/i;

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
function chooseChartType(question, rows) {
  const q = String(question || "");
  const data = Array.isArray(rows) ? rows.filter(Boolean) : [];

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
  if (numeric.length >= 2 && data.length > 1 && !(temporal && numeric.length <= 2)) {
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

  // Structure. Beyond this point the question's wording matters, so the model
  // is allowed to disagree.
  if (CHANGE_QUESTION.test(q)) {
    return { type: "variance", reason: "the question is about a change", fixed: false };
  }

  if (SHARE_QUESTION.test(q) && data.length <= MAX_DONUT_SLICES) {
    return {
      type: "donut",
      reason: `${data.length} parts of a whole`,
      fixed: false,
    };
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

module.exports = { chooseChartType, classify, isTemporal };
