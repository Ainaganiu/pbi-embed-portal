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

test("a share question over few categories is a donut", () => {
  const got = chooseChartType("what is the split of sales by region", genres(4));
  assert.equal(got.type, "donut");
});

test("a share question over many categories is not a donut", () => {
  const got = chooseChartType("what is the split of sales by genre", genres(10));
  assert.notEqual(got.type, "donut");
});

test("a change question is a variance chart", () => {
  const got = chooseChartType("how did sales change versus last year by genre", genres(5));
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
