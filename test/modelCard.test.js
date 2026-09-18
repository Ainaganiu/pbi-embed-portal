// test/modelCard.test.js

const test = require("node:test");
const assert = require("node:assert");

const { reconcile } = require("../lib/modelCard");

const META = {
  tables: [{ name: "DataTable", storageMode: "Import", dataCategory: "Regular" }],
  measures: [
    { name: "1_ Total Interactions", table: "DataTable", dataType: "Integer", formatString: null, expression: null, description: null },
    { name: "2_ Breaches", table: "DataTable", dataType: "Integer", formatString: "0", expression: null, description: null },
  ],
  columns: [
    { name: "Interaction Type", table: "DataTable", dataType: "Text", formatString: null, summarizeBy: "None", description: null },
    { name: "ID", table: "DataTable", dataType: "Integer", formatString: null, summarizeBy: "Count", description: null },
  ],
  relationships: [],
};

test("a bracketed reference attaches its line to the measure", () => {
  const got = reconcile(META, {
    measuresDescription: "[1_ Total Interactions] counts every ticket received.",
  });
  const hit = got.described.find((d) => d.name === "1_ Total Interactions");
  assert.deepEqual(hit.lines, ["[1_ Total Interactions] counts every ticket received."]);
});

test("a table-qualified reference matches too", () => {
  const got = reconcile(META, {
    columnsDescription: "'DataTable'[Interaction Type] is the channel it arrived through.",
  });
  assert.ok(got.described.some((d) => d.name === "Interaction Type"));
});

test("a bare name of four characters or more matches", () => {
  const got = reconcile(META, {
    columnsDescription: "Interaction Type is the channel a ticket arrived through.",
  });
  assert.ok(got.described.some((d) => d.name === "Interaction Type"));
});

test("a short bare name does not match, so unrelated prose is not attached to it", () => {
  const got = reconcile(META, {
    schemaDescription: "Each row is identified by an id we do not expose.",
  });
  assert.ok(
    !got.described.some((d) => d.name === "ID"),
    "a two-letter name would otherwise swallow any sentence containing it"
  );
});

test("every reference to a name is kept, not just the first", () => {
  const got = reconcile(META, {
    measuresDescription:
      "[1_ Total Interactions] counts tickets.\nOther notes.\n[1_ Total Interactions] excludes test rows.",
  });
  const hit = got.described.find((d) => d.name === "1_ Total Interactions");
  assert.equal(hit.lines.length, 2, "an admin who wrote about it twice meant both");
});

test("objects nobody described are listed as gaps", () => {
  const got = reconcile(META, { measuresDescription: "[1_ Total Interactions] counts tickets." });
  assert.ok(got.undescribed.some((u) => u.name === "2_ Breaches"));
});

test("a reference to something that does not exist is reported", () => {
  const got = reconcile(META, { measuresDescription: "[Total Sales] is our headline number." });
  assert.deepEqual(got.unknownReferences, ["Total Sales"]);
});

test("prose matching no object is preserved as notes", () => {
  const got = reconcile(META, { schemaDescription: "SLA is four hours for priority tickets." });
  assert.deepEqual(got.notes, ["SLA is four hours for priority tickets."]);
});

test("no descriptions at all still returns a usable shape", () => {
  const got = reconcile(META, {});
  assert.deepEqual(got.described, []);
  assert.equal(got.undescribed.length, 4);
  assert.deepEqual(got.unknownReferences, []);
  assert.deepEqual(got.notes, []);
});
