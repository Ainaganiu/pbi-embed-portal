// test/modelMetadata.test.js
//
// Fixture rows are copied from a live probe of the IT Service Ticket model,
// including the two system objects that must never reach a prompt: a
// RowNumber column and the hidden DateAutoTemplate table. Fed in raw they
// would teach the model that those are things it may reference.

const test = require("node:test");
const assert = require("node:assert");

const { normalise } = require("../lib/modelMetadata");

const RAW = {
  tables: [
    { "[Name]": "DataTable", "[IsHidden]": false, "[DataCategory]": "Regular", "[StorageMode]": "Import" },
    { "[Name]": "DateAutoTemplate", "[IsHidden]": true, "[DataCategory]": "Time", "[StorageMode]": "Import" },
    { "[Name]": "Date", "[IsHidden]": false, "[DataCategory]": "Time", "[StorageMode]": "Import" },
    { "[Name]": "LocalDateTable_abc123", "[IsHidden]": false, "[DataCategory]": "Time", "[StorageMode]": "Import" },
  ],
  measures: [
    { "[Name]": "1_ Total Interactions", "[Tbl]": "DataTable", "[DataType]": "Integer", "[FormatString]": null, "[Expression]": null, "[Description]": null, "[IsHidden]": false },
    { "[Name]": "Hidden Helper", "[Tbl]": "DataTable", "[DataType]": "Integer", "[FormatString]": null, "[Expression]": null, "[Description]": null, "[IsHidden]": true },
  ],
  columns: [
    { "[Name]": "Interaction ID", "[Tbl]": "DataTable", "[DataType]": "Integer", "[FormatString]": "0", "[SummarizeBy]": "Count", "[Description]": null },
    { "[Name]": "Interaction Type", "[Tbl]": "DataTable", "[DataType]": "Text", "[FormatString]": null, "[SummarizeBy]": "None", "[Description]": null },
    { "[Name]": "RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61", "[Tbl]": "DataTable", "[DataType]": "Integer", "[FormatString]": null, "[SummarizeBy]": "Default", "[Description]": null },
    { "[Name]": "Date", "[Tbl]": "LocalDateTable_abc123", "[DataType]": "DateTime", "[FormatString]": null, "[SummarizeBy]": "None", "[Description]": null },
  ],
  relationships: [
    { "[Rel]": "'DataTable'[Date Received] *[<-]1 'Date'[Date]", "[IsActive]": true, "[FromTable]": "DataTable", "[ToTable]": "Date" },
    { "[Rel]": "'DataTable'[Date Received] *[<-]1 'LocalDateTable_abc123'[Date]", "[IsActive]": true, "[FromTable]": "DataTable", "[ToTable]": "LocalDateTable_abc123" },
  ],
};

test("hidden tables and auto-date tables are dropped", () => {
  const got = normalise(RAW);
  assert.deepEqual(got.tables.map((t) => t.name), ["DataTable", "Date"]);
});

test("a hidden measure is dropped", () => {
  const got = normalise(RAW);
  assert.deepEqual(got.measures.map((m) => m.name), ["1_ Total Interactions"]);
});

test("a RowNumber column is dropped", () => {
  const got = normalise(RAW);
  assert.ok(!got.columns.some((c) => c.name.startsWith("RowNumber-")));
});

test("columns belonging to an auto-date table are dropped", () => {
  const got = normalise(RAW);
  assert.ok(
    !got.columns.some((c) => c.table === "LocalDateTable_abc123"),
    "an auto-date table's columns are noise even though the column itself looks ordinary"
  );
});

test("the fields the card needs survive normalisation", () => {
  const got = normalise(RAW);
  assert.deepEqual(got.columns.find((c) => c.name === "Interaction ID"), {
    name: "Interaction ID",
    table: "DataTable",
    dataType: "Integer",
    formatString: "0",
    summarizeBy: "Count",
    description: null,
    expression: null,
  });
});

test("a relationship keeps Power BI's own rendering verbatim", () => {
  const got = normalise(RAW);
  assert.equal(got.relationships[0].text, "'DataTable'[Date Received] *[<-]1 'Date'[Date]");
  assert.equal(got.relationships[0].isActive, true);
});

test("a relationship pointing at an auto-date table is dropped", () => {
  const got = normalise(RAW);
  assert.deepEqual(got.relationships.map((r) => r.toTable), ["Date"]);
});

test("missing sections normalise to empty arrays rather than throwing", () => {
  const got = normalise({});
  assert.deepEqual(got, { tables: [], measures: [], columns: [], relationships: [] });
});

// A nameless row must never reach storage: reconcile()/render() call
// .toLowerCase() on every object's name with no null guard, so a stored
// row with name: null throws and takes chat down until someone fixes the DB
// row by hand. Filtering it out here is the defense-in-depth half of that
// fix; schemaContext()'s try/catch is the actual gate.
test("a table with no name is dropped rather than stored with name: null", () => {
  const got = normalise({
    tables: [
      { "[Name]": null, "[IsHidden]": false, "[DataCategory]": "Regular", "[StorageMode]": "Import" },
      { "[Name]": "DataTable", "[IsHidden]": false, "[DataCategory]": "Regular", "[StorageMode]": "Import" },
    ],
  });
  assert.deepEqual(got.tables.map((t) => t.name), ["DataTable"]);
});

test("a measure with no name is dropped", () => {
  const got = normalise({
    tables: [{ "[Name]": "DataTable", "[IsHidden]": false }],
    measures: [
      { "[Name]": null, "[Tbl]": "DataTable", "[IsHidden]": false },
      { "[Name]": "Total", "[Tbl]": "DataTable", "[IsHidden]": false },
    ],
  });
  assert.deepEqual(got.measures.map((m) => m.name), ["Total"]);
});

test("a column with no name is dropped", () => {
  const got = normalise({
    tables: [{ "[Name]": "DataTable", "[IsHidden]": false }],
    columns: [
      { "[Name]": null, "[Tbl]": "DataTable" },
      { "[Name]": "Genre", "[Tbl]": "DataTable" },
    ],
  });
  assert.deepEqual(got.columns.map((c) => c.name), ["Genre"]);
});

test("a relationship with no rendered text is dropped", () => {
  const got = normalise({
    tables: [
      { "[Name]": "DataTable", "[IsHidden]": false },
      { "[Name]": "Date", "[IsHidden]": false },
    ],
    relationships: [
      { "[Rel]": null, "[IsActive]": true, "[FromTable]": "DataTable", "[ToTable]": "Date" },
      { "[Rel]": "'DataTable'[X] *[<-]1 'Date'[Y]", "[IsActive]": true, "[FromTable]": "DataTable", "[ToTable]": "Date" },
    ],
  });
  assert.equal(got.relationships.length, 1);
  assert.equal(got.relationships[0].text, "'DataTable'[X] *[<-]1 'Date'[Y]");
});

const path = require("node:path");
const ROOT = path.join(__dirname, "..");

test("a rejected query resolves to null rather than propagating", async () => {
  const full = require.resolve(path.join(ROOT, "lib/powerbi"));
  const original = require.cache[full];
  require.cache[full] = {
    id: full,
    filename: full,
    loaded: true,
    exports: { executeQuery: async () => { throw new Error("401 Unauthorized"); } },
  };
  delete require.cache[require.resolve(path.join(ROOT, "lib/modelMetadata"))];
  const { fetchModelMetadata } = require(path.join(ROOT, "lib/modelMetadata"));

  const got = await fetchModelMetadata({}, { workspaceId: "w", datasetId: "d" });
  assert.equal(got, null, "chat must survive a model that refuses to describe itself");

  if (original) require.cache[full] = original;
  else delete require.cache[full];
});

test("a successful read with zero tables resolves to null, not an empty-but-truthy object", async () => {
  const full = require.resolve(path.join(ROOT, "lib/powerbi"));
  const original = require.cache[full];
  require.cache[full] = {
    id: full,
    filename: full,
    loaded: true,
    // Shaped exactly like a real (successful) response, just empty --
    // an unexpected shape or a permission mode that yields no rows rather
    // than an error, distinct from executeQuery throwing.
    exports: { executeQuery: async () => [] },
  };
  delete require.cache[require.resolve(path.join(ROOT, "lib/modelMetadata"))];
  const { fetchModelMetadata } = require(path.join(ROOT, "lib/modelMetadata"));

  const got = await fetchModelMetadata({}, { workspaceId: "w", datasetId: "d" });
  assert.equal(
    got,
    null,
    "an empty-but-successful read must not silently replace a good typed description with an empty card"
  );

  if (original) require.cache[full] = original;
  else delete require.cache[full];
});

const { mergeDefinition } = require("../lib/modelMetadata");

const METADATA = {
  tables: [{ name: "Data", storageMode: "Import", dataCategory: "Regular" }],
  measures: [{ name: "Number of Console", table: "Data", dataType: "Integer", formatString: "0", expression: null, description: null }],
  columns: [{ name: "Year", table: "Data", dataType: "Int64", formatString: "0", summarizeBy: "Sum", description: null, expression: null }],
  relationships: [{ text: "'Data'[Date] *[<-]1 'Date'[Date]", isActive: true, fromTable: "Data", toTable: "Date", crossFilteringBehavior: null }],
};

test("a null definition leaves metadata completely unchanged", () => {
  const got = mergeDefinition(METADATA, null);
  assert.deepEqual(got, METADATA);
});

test("a measure's expression is overlaid by name match", () => {
  const definition = {
    measures: [{ name: "Number of Console", expression: "DISTINCTCOUNT(Data[Console])" }],
    columns: [],
    relationships: [],
  };
  const got = mergeDefinition(METADATA, definition);
  assert.equal(got.measures[0].expression, "DISTINCTCOUNT(Data[Console])");
});

test("a calculated column's expression is overlaid by table+name match", () => {
  const definition = {
    measures: [],
    columns: [{ name: "Year", table: "Data", expression: "YEAR(Data[Date])" }],
    relationships: [],
  };
  const got = mergeDefinition(METADATA, definition);
  assert.equal(got.columns[0].expression, "YEAR(Data[Date])");
});

test("a relationship's crossFilteringBehavior is overlaid by table-pair match", () => {
  const definition = {
    measures: [],
    columns: [],
    relationships: [{ fromTable: "Data", fromColumn: "Date", toTable: "Date", toColumn: "Date", isActive: true, crossFilteringBehavior: "BothDirections" }],
  };
  const got = mergeDefinition(METADATA, definition);
  assert.equal(got.relationships[0].crossFilteringBehavior, "BothDirections");
});

test("an object present in metadata but absent from the definition keeps its null expression", () => {
  const definition = { measures: [], columns: [], relationships: [] };
  const got = mergeDefinition(METADATA, definition);
  assert.equal(got.measures[0].expression, null);
  assert.equal(got.columns[0].expression, null);
});

test("a colliding pair (two relationships sharing the same table pair) gets no overlay at all", () => {
  const metadataWithCollision = {
    ...METADATA,
    relationships: [
      { text: "'Data'[OrderDate] *[<-]1 'Date'[Date]", isActive: true, fromTable: "Data", toTable: "Date", crossFilteringBehavior: null },
    ],
  };
  const definition = {
    measures: [],
    columns: [],
    relationships: [
      { fromTable: "Data", toTable: "Date", isActive: true, crossFilteringBehavior: "BothDirections" },
      { fromTable: "Data", toTable: "Date", isActive: true, crossFilteringBehavior: null },
    ],
  };
  const got = mergeDefinition(metadataWithCollision, definition);
  assert.equal(
    got.relationships[0].crossFilteringBehavior,
    null,
    "a colliding table pair must not be tagged with either of the colliding values -- silence beats a confident wrong tag"
  );
});

test("a non-colliding pair still gets overlaid normally alongside a colliding one elsewhere", () => {
  const metadataWithBoth = {
    ...METADATA,
    relationships: [
      { text: "'Data'[OrderDate] *[<-]1 'Date'[Date]", isActive: true, fromTable: "Data", toTable: "Date", crossFilteringBehavior: null },
      { text: "'Other'[X] *[<-]1 'OtherDate'[Date]", isActive: true, fromTable: "Other", toTable: "OtherDate", crossFilteringBehavior: null },
    ],
  };
  const definition = {
    measures: [],
    columns: [],
    relationships: [
      { fromTable: "Data", toTable: "Date", isActive: true, crossFilteringBehavior: "BothDirections" },
      { fromTable: "Data", toTable: "Date", isActive: true, crossFilteringBehavior: null },
      { fromTable: "Other", toTable: "OtherDate", isActive: true, crossFilteringBehavior: "BothDirections" },
    ],
  };
  const got = mergeDefinition(metadataWithBoth, definition);
  assert.equal(got.relationships[0].crossFilteringBehavior, null, "the colliding pair stays unchanged");
  assert.equal(got.relationships[1].crossFilteringBehavior, "BothDirections", "the non-colliding pair is still overlaid normally");
});

test("mergeDefinition never mutates its inputs", () => {
  const definition = {
    measures: [{ name: "Number of Console", expression: "DISTINCTCOUNT(Data[Console])" }],
    columns: [],
    relationships: [],
  };
  mergeDefinition(METADATA, definition);
  assert.equal(METADATA.measures[0].expression, null, "the original metadata object must be untouched");
});
