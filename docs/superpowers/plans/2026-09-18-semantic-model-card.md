# Semantic Model Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read a report's semantic model straight from Power BI, merge it with the descriptions the admin typed, and give every prompt one accurate card instead of unverified free text — surfacing, in admin, wherever the two disagree.

**Architecture:** Four `INFO.VIEW.*` DAX queries travel through the existing `executeQuery` path (`lib/modelMetadata.js`), are normalised and stored as JSONB on the report, and are merged at prompt time with the admin's three description fields (`lib/modelCard.js`). `schemaContext()` in `lib/chatHelpers.js` is the single integration point — it renders the merged card when metadata exists and behaves exactly as it does today when it does not. Admin gets a "Sync from model" button and a reconciliation report.

**Tech Stack:** Node 20+, CommonJS, Express 4, `node --test`, Postgres via `pg`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-18-semantic-model-card-design.md`

## Global Constraints

- CommonJS only (`"type": "commonjs"`). Use `require` / `module.exports`, never ESM syntax.
- No new npm dependencies.
- Tests are `node --test`, files matching `test/*.test.js`, using `node:test` and `node:assert`. Run with `npm test`.
- Browser code is plain ES2020 in IIFEs attaching to `window`. No build step, no modules.
- British English in user-facing copy.
- Comments explain *why*, not *what*. Match the existing style; do not add narration comments.
- `executeQuery` is stubbed in every test. No test touches Power BI.
- Chat must never break because metadata is absent, stale or unfetchable. Every failure path falls back to today's behaviour.
- `hasChat` gating stays `Boolean(datasetId && schemaDescription)` — unchanged by this work.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

### Task 1: Fetch and normalise the model metadata

**Files:**
- Create: `lib/modelMetadata.js`
- Test: `test/modelMetadata.test.js`

**Interfaces:**
- Consumes: `executeQuery` from `lib/powerbi.js`.
- Produces:
  - `async fetchModelMetadata(credentials, { workspaceId, datasetId })` → `{ tables, measures, columns, relationships }` or `null` on any failure. Never throws.
  - `normalise(raw)` → the same shape, exported for testing. `raw` is `{ tables, measures, columns, relationships }` of raw Power BI row arrays.
  - Shapes:
    - table: `{ name, storageMode, dataCategory }`
    - measure: `{ name, table, dataType, formatString, expression, description }`
    - column: `{ name, table, dataType, formatString, summarizeBy, description }`
    - relationship: `{ text, isActive, fromTable, toTable }`

- [ ] **Step 1: Write the failing test**

```javascript
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

test("missing sections normalise to empty arrays rather than throwing", () => {
  const got = normalise({});
  assert.deepEqual(got, { tables: [], measures: [], columns: [], relationships: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/modelMetadata.test.js`
Expected: FAIL — `Cannot find module '../lib/modelMetadata'`

- [ ] **Step 3: Write the module**

```javascript
// lib/modelMetadata.js
//
// The semantic model's own account of itself, read through the same
// executeQuery path everything else uses.
//
// These are DAX table functions inside EVALUATE, not a separate API, which is
// the whole reason this is viable: no XMLA, no Premium requirement, and no
// permissions beyond what embedding already needed. Established by probe
// against the live model before any of this was built.

const { executeQuery } = require("./powerbi");

// Power BI returns rows keyed by bracketed name, matching the SELECTCOLUMNS
// aliases below.
const QUERIES = {
  tables: `EVALUATE SELECTCOLUMNS(INFO.VIEW.TABLES(), "Name", [Name], "IsHidden", [IsHidden], "DataCategory", [DataCategory], "StorageMode", [StorageMode])`,
  measures: `EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "Name", [Name], "Tbl", [Table], "DataType", [DataType], "FormatString", [FormatString], "Expression", [Expression], "Description", [Description], "IsHidden", [IsHidden])`,
  columns: `EVALUATE SELECTCOLUMNS(FILTER(INFO.VIEW.COLUMNS(), [IsHidden] = FALSE() && [Type] <> "RowNumber"), "Name", [Name], "Tbl", [Table], "DataType", [DataType], "FormatString", [FormatString], "SummarizeBy", [SummarizeBy], "Description", [Description])`,
  relationships: `EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(), "Rel", [Relationship], "IsActive", [IsActive], "FromTable", [FromTable], "ToTable", [ToTable])`,
};

// Power BI generates a hidden date table per date column when auto date/time
// is on. They carry no meaning a user would recognise and would crowd out the
// real model.
const AUTO_DATE_TABLE = /^(DateAutoTemplate|LocalDateTable_)/i;

const val = (row, key) => {
  const v = row?.[`[${key}]`];
  return v === undefined ? null : v;
};

function normalise(raw) {
  const rawTables = Array.isArray(raw?.tables) ? raw.tables : [];
  const rawMeasures = Array.isArray(raw?.measures) ? raw.measures : [];
  const rawColumns = Array.isArray(raw?.columns) ? raw.columns : [];
  const rawRelationships = Array.isArray(raw?.relationships) ? raw.relationships : [];

  const tables = rawTables
    .filter((r) => val(r, "IsHidden") !== true && !AUTO_DATE_TABLE.test(String(val(r, "Name") || "")))
    .map((r) => ({
      name: val(r, "Name"),
      storageMode: val(r, "StorageMode"),
      dataCategory: val(r, "DataCategory"),
    }));

  const kept = new Set(tables.map((t) => t.name));

  const measures = rawMeasures
    .filter((r) => val(r, "IsHidden") !== true && kept.has(val(r, "Tbl")))
    .map((r) => ({
      name: val(r, "Name"),
      table: val(r, "Tbl"),
      dataType: val(r, "DataType"),
      formatString: val(r, "FormatString"),
      expression: val(r, "Expression"),
      description: val(r, "Description"),
    }));

  // The DAX filter already drops RowNumber columns, but a column can also be
  // noise by association: one belonging to an auto-date table looks perfectly
  // ordinary on its own.
  const columns = rawColumns
    .filter((r) => !String(val(r, "Name") || "").startsWith("RowNumber-") && kept.has(val(r, "Tbl")))
    .map((r) => ({
      name: val(r, "Name"),
      table: val(r, "Tbl"),
      dataType: val(r, "DataType"),
      formatString: val(r, "FormatString"),
      summarizeBy: val(r, "SummarizeBy"),
      description: val(r, "Description"),
    }));

  const relationships = rawRelationships.map((r) => ({
    text: val(r, "Rel"),
    isActive: val(r, "IsActive"),
    fromTable: val(r, "FromTable"),
    toTable: val(r, "ToTable"),
  }));

  return { tables, measures, columns, relationships };
}

/**
 * Reads the model. Resolves to null on any failure -- a report whose metadata
 * cannot be read must keep working on its typed description alone.
 */
async function fetchModelMetadata(credentials, { workspaceId, datasetId }) {
  if (!workspaceId || !datasetId) return null;

  const raw = {};
  for (const [section, dax] of Object.entries(QUERIES)) {
    try {
      raw[section] = await executeQuery(credentials, { workspaceId, datasetId, dax });
    } catch (err) {
      console.error(`[model metadata] ${section} failed:`, err.message);
      return null;
    }
  }
  return normalise(raw);
}

module.exports = { fetchModelMetadata, normalise };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/modelMetadata.test.js`
Expected: PASS, 7 tests

- [ ] **Step 5: Add a test that a failing query yields null, not a throw**

Append to `test/modelMetadata.test.js`:

```javascript
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
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add lib/modelMetadata.js test/modelMetadata.test.js
git commit -m "feat: read the semantic model's own structure

Four INFO.VIEW DAX queries through the existing executeQuery path -- no new
API and no permissions beyond what embedding already needed. System objects
are filtered here rather than at render time: a RowNumber column or a hidden
auto-date table fed to a prompt teaches the model those are things it may
reference.

Any failure resolves to null, because a model that will not describe itself
must not take the chat down with it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Store metadata on the report

**Files:**
- Modify: `lib/db.js` (the ALTER block at the end of `migrate()`)
- Modify: `lib/settings.js` (`rowToReport`, plus a new writer)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `report.modelMetadata` → the normalised object or `null`
  - `report.modelMetadataSyncedAt` → ISO string or `null`
  - `async setModelMetadata(id, metadata)` in `lib/settings.js` → updates both columns, invalidates the cache, returns the updated report.

- [ ] **Step 1: Add the columns**

In `lib/db.js`, after the existing `measures_description` / `columns_description` ALTERs:

```javascript
  // Read from the semantic model rather than typed, so it is cached data
  // rather than configuration -- hence JSONB plus a timestamp, not more text
  // columns.
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS model_metadata JSONB;`);
  await pool.query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS model_metadata_synced_at TIMESTAMPTZ;`);
```

- [ ] **Step 2: Surface them on the report object**

In `lib/settings.js`, in `rowToReport`, after `columnsDescription`:

```javascript
    modelMetadata: row.model_metadata || null,
    modelMetadataSyncedAt: row.model_metadata_synced_at
      ? row.model_metadata_synced_at.toISOString()
      : null,
```

- [ ] **Step 3: Add the writer**

In `lib/settings.js`, after `updateReport`:

```javascript
// Kept separate from updateReport: this is cached data from the model, not
// something the admin edited, and folding it into the report form would mean
// a save with a stale form wiping a fresh sync.
async function setModelMetadata(id, metadata) {
  await pool.query(
    `UPDATE reports SET model_metadata = $2, model_metadata_synced_at = now() WHERE id = $1`,
    [id, metadata ? JSON.stringify(metadata) : null]
  );
  invalidateCache();
  clearStarterCache(id);
  return getReport(id);
}
```

Add `setModelMetadata` to the `module.exports` list.

- [ ] **Step 4: Verify nothing broke**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add lib/db.js lib/settings.js
git commit -m "feat: store the model's metadata on the report

JSONB plus a synced-at stamp rather than more text columns: this is cached
data read from the model, not configuration someone typed. Its writer is
separate from updateReport so that saving the report form with a stale page
cannot wipe a sync that happened since it loaded.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Match descriptions to real objects

**Files:**
- Create: `lib/modelCard.js`
- Test: `test/modelCard.test.js`

**Interfaces:**
- Consumes: the normalised metadata shape from Task 1.
- Produces: `reconcile(metadata, report)` →
  `{ described, undescribed, unknownReferences, notes }` where
  `described` is `[{ kind: "measure"|"column", name, table, lines: string[] }]`,
  `undescribed` is `[{ kind, name, table }]`,
  `unknownReferences` is `string[]`,
  `notes` is `string[]`.

- [ ] **Step 1: Write the failing test**

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/modelCard.test.js`
Expected: FAIL — `Cannot find module '../lib/modelCard'`

- [ ] **Step 3: Write the reconciler**

```javascript
// lib/modelCard.js
//
// The model knows its structure and nothing about what any of it means; the
// admin knows the meaning and has no guarantee the names they typed still
// exist. This joins the two and, just as importantly, reports where they
// disagree -- a description naming a measure that was renamed goes on
// teaching the model to write DAX against something that is not there.

const BUDGETS = require("./budgets");

// Below this length a bare word is too generic to attach prose to: a column
// called "ID" would otherwise claim every sentence mentioning an id.
const MIN_BARE_NAME = 4;

// [Name], 'Table'[Name] or Table[Name] -- the forms someone writing about a
// model actually uses.
const BRACKETED = /(?:'([^']+)'|(\w+))?\[([^\]]+)\]/g;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function descriptionLines(report) {
  return [report.schemaDescription, report.measuresDescription, report.columnsDescription]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function mentions(line, name) {
  const escaped = escapeRegExp(name);
  if (new RegExp(`\\[\\s*${escaped}\\s*\\]`, "i").test(line)) return true;
  if (name.length < MIN_BARE_NAME) return false;
  return new RegExp(`\\b${escaped}\\b`, "i").test(line);
}

function reconcile(metadata, report) {
  const lines = descriptionLines(report || {});
  const objects = [
    ...(metadata?.measures || []).map((m) => ({ kind: "measure", name: m.name, table: m.table })),
    ...(metadata?.columns || []).map((c) => ({ kind: "column", name: c.name, table: c.table })),
  ];

  const described = [];
  const undescribed = [];
  const claimed = new Set();

  for (const obj of objects) {
    const hits = lines.filter((line) => mentions(line, obj.name));
    if (hits.length) {
      hits.forEach((h) => claimed.add(h));
      described.push({ ...obj, lines: hits });
    } else {
      undescribed.push(obj);
    }
  }

  // A bracketed token matching no real object is the drift this exists to
  // catch. Table names count as real: "'DataTable'[Interaction Type]" names
  // both, and only the column part needs to resolve.
  const known = new Set(objects.map((o) => o.name.toLowerCase()));
  const unknownReferences = [];
  for (const line of lines) {
    for (const match of line.matchAll(BRACKETED)) {
      const inner = match[3].trim();
      if (!known.has(inner.toLowerCase()) && !unknownReferences.includes(inner)) {
        unknownReferences.push(inner);
      }
    }
  }

  const notes = lines.filter((line) => !claimed.has(line));

  return { described, undescribed, unknownReferences, notes };
}

module.exports = { reconcile, MIN_BARE_NAME };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/modelCard.test.js`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add lib/modelCard.js test/modelCard.test.js
git commit -m "feat: match typed descriptions to the model's real objects

Bracketed, table-qualified and bare references all match; a bare name under
four characters does not, because a column called ID would otherwise claim
every sentence mentioning an id. Every line referring to a name is kept
rather than the first, since an admin who wrote about a measure twice meant
both.

A bracketed reference matching nothing real is reported as drift -- that is
the case worth catching, because it goes on teaching the model to write DAX
against something that no longer exists.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Render the merged card

**Files:**
- Modify: `lib/modelCard.js`
- Modify: `lib/budgets.js`
- Modify: `test/modelCard.test.js`
- Modify: `test/budgets.test.js`

**Interfaces:**
- Consumes: `reconcile` from Task 3.
- Produces: `render(metadata, report)` → string. Returns `""` when `metadata` is falsy, so callers can test it for emptiness.

- [ ] **Step 1: Add the budget**

In `lib/budgets.js`, after the chart section:

```javascript
  // --- model card ----------------------------------------------------------
  // A ceiling for a pathological model, not a target: the reference model
  // fits whole in a fraction of this. Sits against STATE_CHARS above, which
  // is the other large block a prompt can carry.
  MODEL_CARD_CHARS: 20000,
```

In `test/budgets.test.js`, add `MODEL_CARD_CHARS: 20000,` to the `EXPECTED` object.

- [ ] **Step 2: Write the failing test**

Append to `test/modelCard.test.js`:

```javascript
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

test("no metadata renders nothing, so the caller can fall back", () => {
  assert.equal(render(null, { schemaDescription: "anything" }), "");
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/modelCard.test.js`
Expected: FAIL — `render is not a function`

- [ ] **Step 4: Implement `render`**

Add to `lib/modelCard.js`, above `module.exports`:

```javascript
function qualified(obj) {
  return obj.kind === "measure" ? `[${obj.name}]` : `'${obj.table}'[${obj.name}]`;
}

function describeType(item) {
  const bits = [item.dataType].filter(Boolean);
  if (item.formatString) bits.push(`format "${item.formatString}"`);
  return bits.join(" · ");
}

/**
 * The merged card. Structure from the model, meaning from the admin, and
 * nothing from a reference that does not resolve.
 *
 * Returns "" when there is no metadata, so schemaContext can fall back to the
 * typed description without a second check.
 */
function render(metadata, report) {
  if (!metadata) return "";

  const { described, notes } = reconcile(metadata, report);
  const linesFor = new Map(described.map((d) => [`${d.kind}:${d.name}`, d.lines]));
  const out = [];

  out.push(
    `Read from the semantic model itself. Names and types below are exact — use them verbatim.`
  );

  if (metadata.tables?.length) {
    out.push("\nTABLES");
    for (const t of metadata.tables) {
      const tag = t.dataCategory === "Time" ? " · date table" : "";
      out.push(`  '${t.name}'  ${t.storageMode || ""}${tag}`.trimEnd());
    }
  }

  if (metadata.relationships?.length) {
    out.push("\nRELATIONSHIPS");
    for (const r of metadata.relationships) {
      out.push(`  ${r.text}${r.isActive === false ? "  (inactive)" : ""}`);
    }
  }

  const section = (title, items, kind) => {
    if (!items?.length) return;
    out.push(`\n${title}`);
    for (const item of items) {
      const obj = { kind, name: item.name, table: item.table };
      out.push(`  ${qualified(obj)}  ${describeType(item)}`.trimEnd());
      const lines = linesFor.get(`${kind}:${item.name}`);
      if (lines) lines.forEach((l) => out.push(`      ${l}`));
      else out.push(`      (no description)`);
    }
  };

  section("MEASURES", metadata.measures, "measure");

  // Columns are the most numerous and the least individually load-bearing, so
  // they are what gives way when a model is too wide to fit.
  const before = out.join("\n").length;
  const columnLines = [];
  let omitted = 0;
  for (const col of metadata.columns || []) {
    const obj = { kind: "column", name: col.name, table: col.table };
    const entry = [`  ${qualified(obj)}  ${describeType(col)}`.trimEnd()];
    const lines = linesFor.get(`column:${col.name}`);
    if (lines) lines.forEach((l) => entry.push(`      ${l}`));
    else entry.push(`      (no description)`);

    const addition = entry.join("\n").length + 1;
    if (before + columnLines.join("\n").length + addition > BUDGETS.MODEL_CARD_CHARS - 200) {
      omitted += 1;
      continue;
    }
    columnLines.push(...entry);
  }
  if (columnLines.length) {
    out.push("\nCOLUMNS");
    out.push(...columnLines);
  }
  if (omitted) out.push(`  (${omitted} further columns omitted.)`);

  if (notes.length) {
    out.push("\nNOTES");
    notes.forEach((n) => out.push(`  ${n}`));
  }

  return out.join("\n").slice(0, BUDGETS.MODEL_CARD_CHARS);
}
```

Update the export line:

```javascript
module.exports = { reconcile, render, MIN_BARE_NAME };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/modelCard.test.js test/budgets.test.js`
Expected: PASS

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add lib/modelCard.js lib/budgets.js test/modelCard.test.js test/budgets.test.js
git commit -m "feat: render the model and the descriptions as one card

Structure from the model, each description sitting under the object it
actually describes, and '(no description)' where nothing does -- a gap the
model can see is a gap it can admit to, which is what the grounding rule
asks of it. Relationships are reproduced exactly as Power BI rendered them.

A reference that resolves to nothing is dropped rather than repeated.
Columns give way first when a model is too wide, and the card says how many
it left out instead of ending mid-list.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Feed the card to every prompt

**Files:**
- Modify: `lib/chatHelpers.js` (`schemaContext`)
- Test: `test/markers.test.js`

**Interfaces:**
- Consumes: `render` from Task 4.
- Produces: `schemaContext(report)` — unchanged signature. Returns the merged card when `report.modelMetadata` is present, otherwise exactly what it returns today.

- [ ] **Step 1: Write the failing test**

Append to `test/markers.test.js`:

```javascript
test("schemaContext renders the model card when metadata is present", () => {
  const got = schemaContext({
    schemaDescription: "Tickets and SLA outcomes.",
    modelMetadata: {
      tables: [{ name: "DataTable", storageMode: "Import", dataCategory: "Regular" }],
      measures: [{ name: "Total", table: "DataTable", dataType: "Integer", formatString: null, expression: null, description: null }],
      columns: [],
      relationships: [],
    },
  });
  assert.match(got, /Read from the semantic model itself/);
  assert.match(got, /\[Total\]/);
});

test("schemaContext without metadata behaves exactly as before", () => {
  const got = schemaContext({
    schemaDescription: "Data[Genre], [Sales]",
    measuresDescription: "[Sales] is net revenue.",
  });
  assert.equal(got, "Data[Genre], [Sales]\n\nMeasure definitions:\n[Sales] is net revenue.");
});

test("schemaContext with neither is still the existing placeholder", () => {
  assert.equal(schemaContext({}), "(not described)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/markers.test.js`
Expected: FAIL — the card assertions fail; the fallback ones pass.

- [ ] **Step 3: Implement**

In `lib/chatHelpers.js`, replace the body of `schemaContext`:

```javascript
function schemaContext(report) {
  // One card when the model has been read: structure from the model, meaning
  // from the descriptions, merged. Falls back to the typed text alone
  // whenever it has not been, so nothing here can take the chat down.
  const card = renderModelCard(report?.modelMetadata || null, report || {});
  if (card) return card;

  const parts = [];
  if (report.schemaDescription) parts.push(report.schemaDescription);
  if (report.measuresDescription) parts.push(`Measure definitions:\n${report.measuresDescription}`);
  if (report.columnsDescription) parts.push(`Column definitions:\n${report.columnsDescription}`);
  return parts.length ? parts.join("\n\n") : "(not described)";
}
```

Add the require at the top of `lib/chatHelpers.js`, beside the existing `BUDGETS` require:

```javascript
const { render: renderModelCard } = require("./modelCard");
```

Note: `lib/modelCard.js` requires `./budgets` only, so there is no cycle.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/markers.test.js`
Expected: PASS

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS — every prompt that consumes `schemaContext` keeps working.
Run: `npm run check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add lib/chatHelpers.js test/markers.test.js
git commit -m "feat: give every prompt the merged card when the model has been read

One integration point. Five prompts consume schemaContext and none of them
change: with metadata they get the card, without it they get exactly the
typed description they got before.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Sync endpoint

**Files:**
- Modify: `routes/admin.js` (delete the throwaway probe block, add the sync route)

**Interfaces:**
- Consumes: `fetchModelMetadata` (Task 1), `setModelMetadata` (Task 2), `reconcile` (Task 3).
- Produces: `POST /api/admin/reports/:id/sync-model` →
  `{ syncedAt, counts: { tables, measures, columns, relationships }, reconciliation: { describedCount, undescribed, unknownReferences } }`
  or `502` with `{ error }` when the model cannot be read.

- [ ] **Step 1: Delete the spike**

Remove the entire `THROWAWAY SPIKE` block from `routes/admin.js` — the `PROBES` array and the `router.get("/probe-metadata/:reportId", ...)` handler. Its question is answered; leaving a raw metadata dump on a deployed admin surface is not something to keep by accident.

- [ ] **Step 2: Add the sync route**

In `routes/admin.js`, before `module.exports`:

```javascript
router.post("/reports/:id/sync-model", async (req, res) => {
  const reports = await getReports();
  const report = (reports || []).find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: `Unknown report "${req.params.id}"` });
  if (!report.datasetId) {
    return res.status(400).json({ error: "This report has no dataset to read." });
  }

  const settings = await getSettings();
  const metadata = await fetchModelMetadata(
    {
      tenantId: settings.pbiTenantId,
      clientId: settings.pbiClientId,
      clientSecret: settings.pbiClientSecret,
    },
    { workspaceId: report.workspaceId, datasetId: report.datasetId }
  );

  // Deliberately not written: a failed refresh must not leave the report
  // worse off than it was before someone pressed the button.
  if (!metadata) {
    return res.status(502).json({
      error: "Couldn't read this model's metadata. The service principal may not have access to it.",
    });
  }

  const saved = await setModelMetadata(report.id, metadata);
  const { described, undescribed, unknownReferences } = reconcile(metadata, saved);

  res.json({
    syncedAt: saved.modelMetadataSyncedAt,
    counts: {
      tables: metadata.tables.length,
      measures: metadata.measures.length,
      columns: metadata.columns.length,
      relationships: metadata.relationships.length,
    },
    reconciliation: {
      describedCount: described.length,
      undescribed: undescribed.map((u) => `${u.kind === "measure" ? "[" + u.name + "]" : "'" + u.table + "'[" + u.name + "]"}`),
      unknownReferences,
    },
  });
});
```

Add the requires at the top of `routes/admin.js`:

```javascript
const { fetchModelMetadata } = require("../lib/modelMetadata");
const { reconcile } = require("../lib/modelCard");
```

and add `setModelMetadata` to the existing `require("../lib/settings")` destructure.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0
Run: `grep -rn "probe-metadata" routes public server.js`
Expected: no matches — the spike is gone.

- [ ] **Step 4: Commit**

```bash
git add routes/admin.js
git commit -m "feat: sync a report's model metadata from admin

Replaces the throwaway probe that proved this was possible. A failed read
returns 502 and writes nothing, so pressing sync can never leave a report
worse off than before it was pressed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Sync button and reconciliation report in admin

**Files:**
- Modify: `public/admin.html`, `public/admin.js`, `public/style.css`

**Interfaces:**
- Consumes: `POST /api/admin/reports/:id/sync-model` (Task 6).

- [ ] **Step 1: Add the markup**

In `public/admin.html`, after the `#report-columns` field block:

```html
        <div class="field">
          <label>Semantic model</label>
          <div class="model-sync">
            <button type="button" class="btn-secondary" id="sync-model" style="width:auto;">Sync from model</button>
            <span id="model-synced-at" class="hint"></span>
          </div>
          <div id="model-report" class="model-report" hidden></div>
          <div class="hint">Reads the tables, measures, columns and relationships straight from Power BI, so the AI works from exact names rather than what was typed here.</div>
        </div>
```

- [ ] **Step 2: Wire it up**

In `public/admin.js`, inside `openEditor`, after the existing field assignments:

```javascript
    $("model-synced-at").textContent = editing && report.modelMetadataSyncedAt
      ? `Last synced ${new Date(report.modelMetadataSyncedAt).toLocaleString()}`
      : "Never synced";
    $("model-report").hidden = true;
    $("sync-model").disabled = !editing;
```

Near the other listeners at the bottom of the file:

```javascript
  $("sync-model").addEventListener("click", async () => {
    const id = $("report-editing-id").value;
    if (!id) return;

    const btn = $("sync-model");
    const panel = $("model-report");
    btn.disabled = true;
    btn.textContent = "Syncing…";
    try {
      const r = await api(`/api/admin/reports/${encodeURIComponent(id)}/sync-model`, { method: "POST" });
      $("model-synced-at").textContent = `Last synced ${new Date(r.syncedAt).toLocaleString()}`;

      const rows = [
        `<div><strong>${r.counts.tables}</strong> tables, <strong>${r.counts.measures}</strong> measures, ` +
          `<strong>${r.counts.columns}</strong> columns, <strong>${r.counts.relationships}</strong> relationships.</div>`,
        `<div>${r.reconciliation.describedCount} described by your notes.</div>`,
      ];
      // The two lists worth acting on: what the AI will be told nothing
      // about, and what your notes claim exists but the model has never
      // heard of.
      if (r.reconciliation.undescribed.length) {
        rows.push(
          `<details><summary>${r.reconciliation.undescribed.length} without a description</summary><pre>` +
            escapeHtml(r.reconciliation.undescribed.join("\n")) +
            `</pre></details>`
        );
      }
      if (r.reconciliation.unknownReferences.length) {
        rows.push(
          `<div class="model-report-warn">Your notes mention ` +
            escapeHtml(r.reconciliation.unknownReferences.join(", ")) +
            `, which this model does not contain. That text is left out of what the AI is given.</div>`
        );
      }
      panel.innerHTML = rows.join("");
      panel.hidden = false;
    } catch (err) {
      panel.innerHTML = `<div class="model-report-warn">${escapeHtml(err.message)}</div>`;
      panel.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = "Sync from model";
    }
  });
```

If `public/admin.js` has no `escapeHtml`, add it beside the other helpers:

```javascript
  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }
```

- [ ] **Step 3: Style it**

Add to `public/style.css`:

```css
.model-sync { display: flex; align-items: center; gap: 10px; }
.model-report {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
}
.model-report pre { white-space: pre-wrap; margin: 6px 0 0; font-size: 11px; }
.model-report-warn { color: var(--text); font-weight: 600; margin-top: 6px; }
```

- [ ] **Step 4: Verify**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0
Run: `node --check public/admin.js`
Expected: exit 0

The browser behaviour cannot be exercised here — say so plainly in the report rather than claiming a check that was not run.

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/admin.js public/style.css
git commit -m "feat: sync the model from admin and show what disagrees

The counts confirm it read something real. The two lists underneath are the
point: what the AI will be told nothing about, and what your notes claim
exists that the model has never heard of -- shown where someone can act on
it, which is the whole reason this runs on a button rather than silently on
every question.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document it**

In the README's chat/architecture section, after the existing flow paragraph:

```markdown
Each report can also be synced against its semantic model from `/admin`,
which reads the tables, columns, measures, format strings and relationships
straight from Power BI. Those are merged with the descriptions typed in admin
into one card the AI is given, so it works from exact names rather than
remembered ones — and the sync reports anything your notes mention that the
model does not actually contain.
```

In the project-structure block, after `lib/starters.js`:

```markdown
lib/modelMetadata.js                 # Reads the semantic model via DAX INFO functions
lib/modelCard.js                      # Merges that with the admin's descriptions
```

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: PASS — every suite.
Run: `npm run check`
Expected: exit 0.
Run: `grep -rn "probe-metadata" . --include=*.js --exclude-dir=node_modules`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the semantic model sync

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review notes

Checked against the spec:

- **Acquisition** — Task 1, including the system-object filtering the spec calls out by name (`RowNumber-…`, `DateAutoTemplate`, `LocalDateTable_*`) and the never-throws contract.
- **Storage** — Task 2. `setModelMetadata` is separate from `updateReport` so a stale report form cannot wipe a fresh sync; the spec implies this, the plan makes it explicit.
- **Matching** — Task 3. Every rule in the spec has a test: bracketed, qualified, bare ≥ 4 characters, short bare rejected, all matching lines kept, unknown references, leftover notes.
- **Rendering and budget** — Task 4. `MODEL_CARD_CHARS = 20000` matches the spec exactly; columns truncate first and the card states the omission.
- **Integration** — Task 5, the single `schemaContext` change, with a test pinning byte-identical fallback behaviour.
- **Sync and reconciliation UI** — Tasks 6 and 7, including deleting the throwaway probe, and the "write nothing on failure" rule.
- **Fallback** — Tasks 1, 4, 5 and 6 each carry their own failure path; `hasChat` is untouched throughout, as the spec requires.

Type consistency checked: the normalised shapes in Task 1 are the shapes Task 3 reads and Task 4 renders; `reconcile`'s four-key return is used identically in Tasks 4, 6 and 7; `render(metadata, report)` has the same two parameters in Tasks 4 and 5; `setModelMetadata(id, metadata)` is defined in Task 2 and called in Task 6.

Not covered, deliberately, per the spec's "Not in this design": distinct filter values, replacing the admin description fields, auto-refresh. The `FormatString`-as-fact follow-on is recorded in the spec and is not planned here.
