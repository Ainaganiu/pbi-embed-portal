// test/chartShape.test.js
//
// The type switcher offers every form the ROWS support, while buildChartSpec
// emits a different key shape per type. These cover the crossing of the two:
// picking a bar for rows that were built as a table used to hand the bar
// renderer a spec with no labels and no values, and the figure went blank.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { deriveRenderable } = require("../public/chartShape");
const { buildChartSpec, validTypesFor } = require("../lib/chartChoice");

// charts.js is browser code in an IIFE. Nothing in it touches d3 or the DOM at
// load time, so it can be evaluated against a bare sandbox to reach toCsv --
// the drawing still needs a browser, but the CSV mapping does not.
function loadPortalCharts() {
  const sandbox = {
    window: {},
    ChartShape: require("../public/chartShape"),
    ChartGeometry: require("../public/chartGeometry"),
    d3: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "public", "charts.js"), "utf8"), sandbox);
  return sandbox.window.PortalCharts;
}

const TWO_MEASURE_ROWS = [
  { "Data[Genre]": "Action", "[Sales]": 10, "[Units]": 4 },
  { "Data[Genre]": "Sports", "[Sales]": 8, "[Units]": 3 },
];

test("a table-shaped spec switched to a bar gets labels and series", () => {
  const spec = buildChartSpec("sales and units by genre", TWO_MEASURE_ROWS);
  assert.equal(spec.type, "table", "two measures build a table");
  assert.ok(validTypesFor(TWO_MEASURE_ROWS).includes("bar"), "and bar is offered as an alternative");

  const shaped = deriveRenderable(spec, "bar");
  assert.equal(shaped.type, "bar");
  assert.deepEqual(shaped.labels, ["Action", "Sports"]);
  assert.deepEqual(
    shaped.series.map((s) => [s.name, s.scenario, s.values]),
    [
      ["Sales", "AC", [10, 8]],
      ["Units", "PY", [4, 3]],
    ]
  );
});

test("a table of one measure switched to a bar gets flat values", () => {
  const spec = {
    type: "table",
    label: "Sales",
    columns: ["Genre", "Sales"],
    rows: [["Action", 10], ["Sports", 8]],
  };
  const shaped = deriveRenderable(spec, "column");
  assert.deepEqual(shaped.labels, ["Action", "Sports"]);
  assert.deepEqual(shaped.values, [10, 8]);
});

test("a card switched to a table gets one column and one row", () => {
  const spec = buildChartSpec("total sales", [{ "[Sales]": 42 }]);
  assert.equal(spec.type, "card");
  assert.deepEqual(validTypesFor([{ "[Sales]": 42 }]), ["card", "table"]);

  const shaped = deriveRenderable(spec, "table");
  assert.equal(shaped.type, "table");
  assert.deepEqual(shaped.columns, ["Sales"]);
  assert.deepEqual(shaped.rows, [[42]]);
});

test("a card drawn as a chart gets its caption as its one label", () => {
  const shaped = deriveRenderable({ type: "card", values: [42], label: "Sales" }, "bar");
  assert.deepEqual(shaped.labels, ["Sales"]);
  assert.deepEqual(shaped.values, [42]);
});

test("a spec that already fits the type is left alone", () => {
  const spec = { type: "bar", labels: ["a"], values: [1] };
  assert.deepEqual(deriveRenderable(spec, "bar"), spec);
  const grouped = { type: "column", labels: ["a"], series: [{ name: "x", values: [1] }] };
  assert.deepEqual(deriveRenderable(grouped, "line"), { ...grouped, type: "line" });
});

test("three measures stay a table, so the render guard still catches them", () => {
  const spec = {
    type: "table",
    columns: ["Genre", "A", "B", "C"],
    rows: [["Action", 1, 2, 3]],
  };
  const shaped = deriveRenderable(spec, "bar");
  assert.equal(shaped.labels, undefined, "nothing honest to plot, so nothing is invented");
  assert.equal(shaped.values, undefined);
});

test("a table with no categorical column cannot become a chart", () => {
  const spec = { type: "table", columns: ["A", "B"], rows: [[1, 2]] };
  const shaped = deriveRenderable(spec, "bar");
  assert.equal(shaped.labels, undefined);
});

test("truncation and the switcher's options survive the derivation", () => {
  const spec = {
    type: "table",
    columns: ["Genre", "Sales"],
    rows: [["Action", 10]],
    truncated: { shown: 1, total: 9 },
    validTypes: ["bar", "table"],
  };
  const shaped = deriveRenderable(spec, "bar");
  assert.deepEqual(shaped.truncated, { shown: 1, total: 9 });
  assert.deepEqual(shaped.validTypes, ["bar", "table"]);
});

test("a card's CSV carries its value, not just a header", () => {
  const { toCsv } = loadPortalCharts();
  assert.equal(toCsv({ type: "card", values: [42], label: "Total Sales" }), "Total Sales\n42");
  assert.equal(toCsv({ type: "card", values: [42] }), "Value\n42");
});

test("an ordinary chart's CSV is unchanged", () => {
  const { toCsv } = loadPortalCharts();
  assert.equal(
    toCsv({ type: "bar", label: "Sales", labels: ["Action", "Sports"], values: [10, 8] }),
    "Sales,Sales\nAction,10\nSports,8"
  );
});
