const test = require("node:test");
const assert = require("node:assert");

const { fallbackRoute } = require("../lib/route");

const TITLES = [
  { name: "v1", title: "Total Sales by Game", type: "barChart" },
  { name: "v2", title: "Region", type: "slicer" },
];

const route = (question, opts = {}) =>
  fallbackRoute({ question, visualTitles: TITLES, hasDataset: true, ...opts });

test("a DAX how-to is an authoring question", () => {
  assert.equal(route("how do I write a measure for year on year growth").path, "authoring");
});

test("naming DAX at all is enough to be authoring", () => {
  assert.equal(route("my time intelligence calculation returns blank").path, "authoring");
});

test("pointing at the screen routes to the screen", () => {
  assert.equal(route("what is this page telling me").path, "screen");
});

test("naming a visual on the page routes to the screen and focuses it", () => {
  const got = route("what does total sales by game show");
  assert.equal(got.path, "screen");
  assert.equal(got.focusVisual, "v1");
});

test("a single-word title is too weak to focus on", () => {
  const got = route("which region sold most", { visualTitles: TITLES });
  assert.equal(got.focusVisual, null);
});

test("a measurable question goes to the query pipeline", () => {
  assert.equal(route("how many units sold by genre").path, "query");
});

test("an open-ended question that is also specific prefers the query pipeline", () => {
  assert.equal(route("explain how many units sold by region").path, "query");
});

test("a short ambiguous question prefers the screen", () => {
  assert.equal(route("anything odd").path, "screen");
});

test("a long ambiguous question falls to the query pipeline", () => {
  assert.equal(route("give me the numbers behind last quarter performance overall").path, "query");
});

test("without a dataset everything routes to the screen", () => {
  assert.equal(route("how many units sold by genre", { hasDataset: false }).path, "screen");
  assert.equal(route("how do I write a measure", { hasDataset: false }).path, "screen");
});

test("the fallback always reports low confidence", () => {
  assert.equal(route("what is this page telling me").confidence, "low");
});
