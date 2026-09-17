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
