const test = require("node:test");
const assert = require("node:assert");

const { chooseChartType, isTemporal } = require("../lib/chartChoice");

// Rows arrive from Power BI keyed by qualified column name.
const genres = (n) =>
  ["Action", "Sports", "Shooter", "Role-Playing", "Misc", "Platform", "Racing", "Fighting", "Simulation", "Adventure", "Strategy", "Puzzle", "Board", "Party"]
    .slice(0, n)
    .map((g, i) => ({ "Data[Genre]": g, "[Sales]": 33110 - i * 2000 }));

const years = (n) =>
  Array.from({ length: n }, (_, i) => ({ "Date[Year]": String(2010 + i), "[Sales]": 40000 + i * 1000 }));

test("a single value is a card, and that is not negotiable", () => {
  const got = chooseChartType("what were total sales in 2015", [{ "[Total Sales]": 330560 }]);
  assert.equal(got.type, "card");
  assert.equal(got.fixed, true);
});

test("two measures per row is a table", () => {
  const rows = [
    { "Data[Game]": "Fifa 17", "[2016]": 8410, "[2015]": 7200 },
    { "Data[Game]": "Far Cry", "[2016]": 3540, "[2015]": 4100 },
  ];
  const got = chooseChartType("compare these games with last year", rows);
  assert.equal(got.type, "table");
  assert.equal(got.fixed, true);
});

test("a long time series is a line", () => {
  const got = chooseChartType("how have sales trended", years(8));
  assert.equal(got.type, "line");
});

test("a short time series is a column, not a bar", () => {
  const got = chooseChartType("sales by year", years(3));
  assert.equal(got.type, "column");
  assert.equal(got.fixed, true, "vertical-for-time is a rule, not a preference");
});

test("categories are horizontal bars, never columns", () => {
  const got = chooseChartType("total revenue by genre top 10 in 2016", genres(10));
  assert.equal(got.type, "bar");
});

test("many categories force a bar so the labels fit", () => {
  const got = chooseChartType("sales by genre", genres(14));
  assert.equal(got.type, "bar");
  assert.equal(got.fixed, true);
});

test("a share intent over few categories is a donut", () => {
  const got = chooseChartType("what is the split of sales by region", genres(4), "share");
  assert.equal(got.type, "donut");
});

test("a share intent over many categories is not a donut", () => {
  const got = chooseChartType("what is the split of sales by genre", genres(10), "share");
  assert.notEqual(got.type, "donut");
});

test("a change intent is a variance chart", () => {
  const got = chooseChartType("how did sales change versus last year by genre", genres(5), "change");
  assert.equal(got.type, "variance");
});

test("no rows means no chart", () => {
  assert.equal(chooseChartType("anything", []).type, null);
});

test("rows with no numeric column mean no chart", () => {
  const got = chooseChartType("list the genres", [{ "Data[Genre]": "Action" }, { "Data[Genre]": "Sports" }]);
  assert.equal(got.type, null);
});

// The real cases from the session this was built in.
test("regression: publisher with the highest sales in 2015 is a card", () => {
  const got = chooseChartType("which publisher had the highest sales in 2015", [
    { "Data[Publisher]": "Electronic Arts", "[Total Sales]": 51260 },
  ]);
  assert.equal(got.type, "card", "one row, one measure — the name is a label, not a series");
});

test("temporal detection works on values, not just column names", () => {
  const rows = [{ "Data[Label]": "2014" }, { "Data[Label]": "2015" }];
  assert.equal(isTemporal("Data[Label]", rows), true);

  const notYears = [{ "Data[Label]": "Action" }, { "Data[Label]": "Sports" }];
  assert.equal(isTemporal("Data[Label]", notYears), false);
});

test("a column of mixed types is a label, not a measure", () => {
  // One stray string in a numeric column used to make it count as a measure,
  // which turned a two-column result into a spurious table.
  const rows = [
    { "Data[Genre]": "Action", "[Sales]": 100 },
    { "Data[Genre]": "Sports", "[Sales]": "n/a" },
  ];
  const got = chooseChartType("sales by genre", rows);
  assert.equal(got.type, null, "no fully numeric column means nothing to plot");
});

test("a time series with two measures stays a chart, not a table", () => {
  // Verification caught this: "sales by year" with an actual and a prior-year
  // column was being routed to a table, throwing away the trend.
  const rows = Array.from({ length: 10 }, (_, i) => ({
    "Date[Year]": String(2007 + i),
    "[Sales]": 400000 + i * 1000,
    "[Prior Year]": 390000 + i * 1000,
  }));
  assert.equal(chooseChartType("sales by year", rows).type, "line");
});

test("three or more measures is a table even over time", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    "Date[Year]": String(2010 + i),
    "[Sales]": 1,
    "[Units]": 2,
    "[Margin]": 3,
  }));
  assert.equal(chooseChartType("everything by year", rows).type, "table");
});

// ---- building the spec, not just choosing the type ----------------------

const { buildChartSpec } = require("../lib/chartChoice");

test("a spec is built straight from the rows", () => {
  const rows = [
    { "Data[Genre]": "Action", "[Total Sales]": 33110 },
    { "Data[Genre]": "Shooter", "[Total Sales]": 20890 },
  ];
  const spec = buildChartSpec("top genres in 2016", rows);
  assert.equal(spec.type, "bar");
  assert.deepEqual(spec.labels, ["Action", "Shooter"]);
  assert.deepEqual(spec.values, [33110, 20890]);
  assert.equal(spec.label, "Total Sales", "the measure name, not its bracketed key");
});

test("two measures over time become AC and PY series", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    "Date[Year]": String(2010 + i),
    "[Sales]": 100 + i,
    "[Prior]": 90 + i,
  }));
  const spec = buildChartSpec("sales by year", rows);
  assert.equal(spec.type, "line");
  assert.equal(spec.series.length, 2);
  assert.equal(spec.series[0].scenario, "AC");
  assert.equal(spec.series[1].scenario, "PY");
  assert.equal(spec.series[0].values.length, 8);
});

test("a table spec keeps every column, category first", () => {
  const rows = [
    { "Data[Genre]": "Action", "[Sales]": 1, "[Games]": 2, "[Share]": 3 },
  ];
  const spec = buildChartSpec("everything by genre", rows);
  assert.equal(spec.type, "table");
  assert.deepEqual(spec.columns, ["Genre", "Sales", "Games", "Share"]);
  assert.deepEqual(spec.rows, [["Action", 1, 2, 3]]);
});

// ---- two grouping dimensions --------------------------------------------
//
// The reported failure: "SLA breaches by channel and issue type" grouped by
// two columns, and the table showed only the first. Four interaction types
// repeated seven times down the page with nothing saying which issue each
// row was -- the column that distinguished them was dropped on the way to
// the screen, while the model's narrative could still see it in the rows and
// named issues the table never showed.
const slaRows = () => {
  const channels = [
    ["Calls", 3897, 3043],
    ["Chats", 1308, 439],
    ["Emails", 2708, 2254],
    ["Escalations", 221, 221],
  ];
  const issues = ["Mobile App Issue", "Fraud Alert", "Close Account", "Open/Account Question"];
  const rows = [];
  for (const issue of issues) {
    for (const [channel, total, breaches] of channels) {
      rows.push({
        "Data[Interaction Type]": channel,
        "Data[Issue Type]": issue,
        "[Total Interactions]": total,
        "[Breaches (Outside SLA)]": breaches,
      });
    }
  }
  return rows;
};

test("a table keeps every grouping column, not just the first", () => {
  const spec = buildChartSpec("sla breaches by channel and issue", slaRows());
  assert.equal(spec.type, "table");
  assert.deepEqual(spec.columns, [
    "Interaction Type",
    "Issue Type",
    "Total Interactions",
    "Breaches (Outside SLA)",
  ]);
  assert.deepEqual(
    spec.rows[0],
    ["Calls", "Mobile App Issue", 3897, 3043],
    "the issue type is what tells one Calls row from the next"
  );
});

test("two dimensions and one measure is a table, not a bar with repeated labels", () => {
  const rows = slaRows().map((r) => ({
    "Data[Interaction Type]": r["Data[Interaction Type]"],
    "Data[Issue Type]": r["Data[Issue Type]"],
    "[Breaches (Outside SLA)]": r["[Breaches (Outside SLA)]"],
  }));
  const got = chooseChartType("sla breaches by channel and issue", rows);
  assert.equal(got.type, "table", "a flat bar would label four bars 'Calls' and mean nothing");
  assert.equal(got.fixed, true);
});

test("a constant grouping column does not force a table", () => {
  // SUMMARIZECOLUMNS over Year and Genre, filtered to one year: the year is
  // technically a second dimension but distinguishes nothing, so the chart
  // should still be a bar by genre.
  const rows = genres(4).map((r) => ({ "Date[Year]": "2016", ...r }));
  assert.equal(chooseChartType("sales by genre in 2016", rows).type, "bar");
});

test("a chart plots the dimension that actually varies, not whichever came first", () => {
  const rows = genres(4).map((r) => ({ "Date[Year]": "2016", ...r }));
  const spec = buildChartSpec("sales by genre in 2016", rows);
  assert.deepEqual(
    spec.labels,
    ["Action", "Sports", "Shooter", "Role-Playing"],
    "labelling every bar 2016 would say nothing at all"
  );
});

test("valid types for two-dimension rows offer only the table", () => {
  assert.deepEqual(validTypesFor(slaRows()), ["table"]);
});

test("a single value builds a card", () => {
  const spec = buildChartSpec("total sales in 2015", [{ "[Total Sales]": 330560 }]);
  assert.equal(spec.type, "card");
  assert.deepEqual(spec.values, [330560]);
});

test("unchartable rows build nothing", () => {
  assert.equal(buildChartSpec("anything", []), null);
  assert.equal(buildChartSpec("list genres", [{ "Data[Genre]": "Action" }, { "Data[Genre]": "Sports" }]), null);
});

// ---- intent hints, truncation, and validTypesFor -------------------------

const { validTypesFor } = require("../lib/chartChoice");

test("an explicit share intent beats the question's wording", () => {
  const got = chooseChartType("break it out for me", genres(4), "share");
  assert.equal(got.type, "donut");
});

test("an explicit change intent produces a variance chart", () => {
  const got = chooseChartType("how did we do", genres(5), "change");
  assert.equal(got.type, "variance");
});

test("intent never overrides a shape-determined choice", () => {
  const got = chooseChartType("what is the split", [{ "[Total]": 42 }], "share");
  assert.equal(got.type, "card", "one number is a card however the question was framed");
});

test("intent never puts time on a horizontal axis", () => {
  const got = chooseChartType("what is the split by year", years(3), "share");
  assert.equal(got.type, "column");
});

test("an unknown intent is ignored rather than honoured", () => {
  const got = chooseChartType("total revenue by genre", genres(6), "sparkline");
  assert.equal(got.type, "bar");
});

test("too many categories are truncated to the top slice, largest first", () => {
  const spec = buildChartSpec("sales by genre", genres(14).concat(
    Array.from({ length: 10 }, (_, i) => ({ "Data[Genre]": `Extra ${i}`, "[Sales]": 100 + i }))
  ));
  assert.equal(spec.labels.length, 15);
  assert.deepEqual(spec.truncated, { shown: 15, total: 24 });
  assert.equal(spec.labels[0], "Action", "the largest value leads");
  assert.ok(spec.values[0] >= spec.values[14], "sorted descending");
});

test("a truncated chart still carries every category under `full`, for CSV", () => {
  const extras = Array.from({ length: 10 }, (_, i) => ({ "Data[Genre]": `Extra ${i}`, "[Sales]": 100 + i }));
  const rows = genres(14).concat(extras);
  const spec = buildChartSpec("sales by genre", rows);

  // The chart itself still only shows the top slice.
  assert.equal(spec.labels.length, 15);
  assert.equal(spec.values.length, 15);

  // But `full` holds every category the query actually returned, unsorted
  // and untruncated -- this is what a CSV download must read from.
  assert.ok(spec.full, "truncated spec carries a full pairing");
  assert.equal(spec.full.labels.length, 24);
  assert.equal(spec.full.values.length, 24);
  const expectedLabels = rows.map((r) => r["Data[Genre]"]);
  assert.deepEqual(spec.full.labels, expectedLabels);
  const expectedValues = rows.map((r) => r["[Sales]"]);
  assert.deepEqual(spec.full.values, expectedValues);
});

test("a set under the threshold keeps its original order and is not marked truncated", () => {
  const spec = buildChartSpec("sales by genre", genres(10));
  assert.equal(spec.labels.length, 10);
  assert.equal(spec.truncated, undefined);
  assert.equal(spec.labels[0], "Action");
});

test("a time series is never reordered, however many points it has", () => {
  const spec = buildChartSpec("sales by year", years(20));
  assert.equal(spec.labels[0], "2010", "reordering a timeline destroys it");
  assert.equal(spec.labels.length, 20);
  assert.equal(spec.truncated, undefined);
});

test("intent reaches buildChartSpec through options", () => {
  const spec = buildChartSpec("break it out", genres(4), { intent: "share" });
  assert.equal(spec.type, "donut");
});

test("a caption still reaches buildChartSpec through options", () => {
  const spec = buildChartSpec("sales by genre", genres(4), { caption: "Units shipped" });
  assert.equal(spec.label, "Units shipped");
});

test("valid types for categorical rows offer the structural forms, not a line", () => {
  const types = validTypesFor(genres(6));
  assert.ok(types.includes("bar"));
  assert.ok(types.includes("donut"));
  assert.ok(types.includes("table"));
  assert.ok(!types.includes("line"), "a line implies an ordered axis these rows do not have");
});

test("valid types for a time series offer line and column", () => {
  const types = validTypesFor(years(9));
  assert.ok(types.includes("line"));
  assert.ok(types.includes("column"));
});

test("valid types for a single number are just the card and the table", () => {
  assert.deepEqual(validTypesFor([{ "[Total]": 42 }]).sort(), ["card", "table"]);
});

test("rows with nothing numeric offer no chart at all", () => {
  assert.deepEqual(validTypesFor([{ "Data[Genre]": "Action" }]), []);
});

// ---- percentage formatting hint --------------------------------------

const PERCENT_FORMAT = { percent: true, decimals: 1, scale: "fraction" };

test("a format hint rides on a bar spec", () => {
  const spec = buildChartSpec("conversion rate by genre", genres(4), { format: PERCENT_FORMAT });
  assert.deepEqual(spec.format, PERCENT_FORMAT);
});

test("a format hint rides on a card spec", () => {
  const spec = buildChartSpec("what is the conversion rate", [{ "[Rate]": 0.42 }], { format: PERCENT_FORMAT });
  assert.equal(spec.type, "card");
  assert.deepEqual(spec.format, PERCENT_FORMAT);
});

test("a format hint rides on a donut spec", () => {
  const spec = buildChartSpec("break down the rate", genres(4), { intent: "share", format: PERCENT_FORMAT });
  assert.equal(spec.type, "donut");
  assert.deepEqual(spec.format, PERCENT_FORMAT);
});

test("a format hint rides on a two-series spec", () => {
  const rows = years(3).map((r) => ({ ...r, "[Rate PY]": 0.1 }));
  const spec = buildChartSpec("rate by year", rows, { format: PERCENT_FORMAT });
  assert.ok(spec.series);
  assert.deepEqual(spec.format, PERCENT_FORMAT);
});

test("no format option means no format key at all, not a null one", () => {
  const spec = buildChartSpec("sales by genre", genres(4));
  assert.ok(!("format" in spec));
});

test("a table spec never carries a format hint, even when one is supplied", () => {
  const rows = [
    { "Data[Game]": "Fifa 17", "[2016]": 8410, "[2015]": 7200 },
    { "Data[Game]": "Far Cry", "[2016]": 3540, "[2015]": 4100 },
  ];
  const spec = buildChartSpec("compare these games", rows, { format: PERCENT_FORMAT });
  assert.equal(spec.type, "table");
  assert.ok(!("format" in spec), "a table can mix percent and non-percent columns");
});

test("a truncated spec keeps both truncated and format together", () => {
  const spec = buildChartSpec(
    "sales by genre",
    genres(14).concat(Array.from({ length: 10 }, (_, i) => ({ "Data[Genre]": `Extra ${i}`, "[Sales]": 100 + i }))),
    { format: PERCENT_FORMAT }
  );
  assert.ok(spec.truncated);
  assert.deepEqual(spec.format, PERCENT_FORMAT);
});
