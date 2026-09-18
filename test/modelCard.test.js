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

test("a bare-bracketed table name is not reported as unknown", () => {
  const got = reconcile(META, { schemaDescription: "All facts live in [DataTable]." });
  assert.deepEqual(got.unknownReferences, []);
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

const { render } = require("../lib/modelCard");

test("the card names the tables, measures and columns exactly", () => {
  const card = render(META, { measuresDescription: "[1_ Total Interactions] counts every ticket." });
  assert.match(card, /'DataTable'/);
  assert.match(card, /\[1_ Total Interactions\]/);
  assert.match(card, /'DataTable'\[Interaction Type\]/);
});

test("a description is attached under the object it describes", () => {
  const card = render(META, { measuresDescription: "[1_ Total Interactions] counts every ticket." });
  const idx = card.indexOf("[1_ Total Interactions]");
  const next = card.indexOf("[2_ Breaches]");
  assert.ok(idx !== -1 && next !== -1 && idx < next);
  assert.ok(
    card.slice(idx, next).includes("counts every ticket"),
    "the description must sit under its own object, not somewhere else in the card"
  );
});

test("an undescribed object says so rather than going silent", () => {
  const card = render(META, {});
  assert.match(card, /no description/i);
});

test("a format string is shown where the author set one", () => {
  const card = render(META, {});
  assert.match(card, /format "0"/);
});

test("a relationship is reproduced exactly as Power BI rendered it", () => {
  const withRel = {
    ...META,
    relationships: [
      { text: "'DataTable'[Date Received] *[<-]1 'Date'[Date]", isActive: true, fromTable: "DataTable", toTable: "Date" },
    ],
  };
  const card = render(withRel, {});
  assert.ok(card.includes("'DataTable'[Date Received] *[<-]1 'Date'[Date]"));
});

test("a reference to something that does not exist never reaches the card", () => {
  const card = render(META, { measuresDescription: "[Total Sales] is our headline number." });
  assert.ok(
    !card.includes("Total Sales"),
    "repeating a name that is not in the model is exactly the behaviour this replaces"
  );
});

test("leftover prose is kept as notes", () => {
  const card = render(META, { schemaDescription: "SLA is four hours for priority tickets." });
  assert.match(card, /SLA is four hours/);
});

test("a note naming a real table in brackets is kept, not dropped as unknown", () => {
  const card = render(META, { schemaDescription: "All facts live in [DataTable]." });
  assert.match(card, /All facts live in \[DataTable\]/);
});

test("no metadata renders nothing, so the caller can fall back", () => {
  assert.equal(render(null, { schemaDescription: "anything" }), "");
});

test("NOTES renders before MEASURES and COLUMNS, so it survives a downstream truncation", () => {
  const card = render(META, { schemaDescription: "SLA is four hours for priority tickets." });
  const notesIdx = card.indexOf("\nNOTES");
  const measuresIdx = card.indexOf("\nMEASURES");
  const columnsIdx = card.indexOf("\nCOLUMNS");
  assert.ok(notesIdx !== -1 && measuresIdx !== -1 && columnsIdx !== -1);
  assert.ok(
    notesIdx < measuresIdx && notesIdx < columnsIdx,
    "callers slice this string to a fixed character budget before MEASURES/COLUMNS are exhausted -- NOTES must come first"
  );
});

test("a huge model is capped and says what it dropped", () => {
  const many = {
    tables: [{ name: "T", storageMode: "Import", dataCategory: "Regular" }],
    measures: [],
    columns: Array.from({ length: 5000 }, (_, i) => ({
      name: `Column Number ${i}`,
      table: "T",
      dataType: "Text",
      formatString: null,
      summarizeBy: "None",
      description: null,
    })),
    relationships: [],
  };
  const card = render(many, {});
  assert.ok(card.length <= 20000);
  assert.match(card, /further columns omitted/i);
});
