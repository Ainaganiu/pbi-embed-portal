// test/chartGeometry.test.js
const test = require("node:test");
const assert = require("node:assert");

const { heightFor, labelsFit, truncateLabel, ROW_HEIGHT } = require("../public/chartGeometry");

test("a bar chart's height grows with its rows", () => {
  const five = heightFor("bar", 5, 360, 2000);
  const fifteen = heightFor("bar", 15, 360, 2000);
  assert.ok(fifteen > five);
  assert.ok(fifteen >= 15 * ROW_HEIGHT, "every row gets its full height");
});

test("fifteen bars are no longer squashed into 260px", () => {
  // The reported defect: the old renderer passed min(width * 0.72, 260) for
  // every chart, giving a fifteen-row bar chart about eleven pixels per row.
  assert.ok(heightFor("bar", 15, 360, 2000) > 260);
});

test("a one-row bar chart still has a usable minimum height", () => {
  assert.ok(heightFor("bar", 1, 360, 2000) >= 120);
});

test("variance sizes like a bar, because it is one", () => {
  assert.equal(heightFor("variance", 9, 360, 2000), heightFor("bar", 9, 360, 2000));
});

test("a line chart is sized by width, not by point count", () => {
  assert.equal(heightFor("line", 8, 400, 2000), heightFor("line", 40, 400, 2000));
});

test("a card is always the same height", () => {
  assert.equal(heightFor("card", 1, 360, 2000), 120);
});

test("maxHeight caps the result", () => {
  assert.equal(heightFor("bar", 100, 360, 500), 500);
});

test("labels fit in a wide band and not in a narrow one", () => {
  assert.equal(labelsFit(40), true);
  assert.equal(labelsFit(12), false);
});

test("a label that fits is returned untouched", () => {
  assert.equal(truncateLabel("Action", 150), "Action");
});

test("a label that does not fit is ellipsised, not clipped", () => {
  const got = truncateLabel("Massively Multiplayer Online Role-Playing", 80);
  assert.ok(got.length < "Massively Multiplayer Online Role-Playing".length);
  assert.ok(got.endsWith("…"));
});

test("truncation never returns an empty label", () => {
  assert.ok(truncateLabel("Role-Playing", 4).length > 0);
});
