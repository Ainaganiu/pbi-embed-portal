# Real DAX in the Model Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read real measure and calculated-column DAX from the semantic model's own Fabric definition (`getDefinition?format=TMSL`), merge it into the existing model card, and ground every DAX-generating prompt in the model's actual formulas instead of just names and types.

**Architecture:** A new acquisition module, `lib/modelDefinition.js`, calls Fabric's `getDefinition` long-running operation independently of the existing Power BI REST calls (a different AAD resource, different API base), decodes the returned `model.bim` (TMSL/JSON), and extracts a narrow field whitelist — never the Power Query/M source. `routes/admin.js`'s existing sync route merges this, best-effort, into the metadata `fetchModelMetadata` already produces, via a new `mergeDefinition` function in `lib/modelMetadata.js`. `lib/modelCard.js`'s `render()` shows the real formula under a measure or calculated column, exactly where an admin's typed description already sits. `lib/answer/dax.js` needs no changes — it already consumes `schemaContext()`, the single integration point.

**Tech Stack:** Node 20+, CommonJS, Express 4, `node --test`, Postgres via `pg`. No new dependencies — Fabric calls use the same global `fetch` the rest of the codebase uses.

**Spec:** `docs/superpowers/specs/2026-09-18-model-dax-grounding-design.md`

## Global Constraints

- CommonJS only (`"type": "commonjs"`). Use `require` / `module.exports`, never ESM syntax.
- No new npm dependencies.
- Tests are `node --test`, files matching `test/*.test.js`, using `node:test` and `node:assert`. Run with `npm test`.
- Comments explain *why*, not *what*. Match the existing style; do not add narration comments.
- Every network call (`fetch`) is stubbed in every test. No test touches Power BI, Fabric, or Azure AD.
- Any acquisition function (`fetchModelDefinition`) never throws — it resolves to `null` on every failure path and logs via `console.error`, matching `fetchModelMetadata`'s existing contract.
- A Fabric-fetch failure must never fail the sync route when the existing INFO.VIEW read succeeded — best-effort enrichment only.
- The Power Query/M source, data sources, roles, and perspectives from the TMSL payload are never parsed into a variable that outlives the function that reads them, and never logged.
- British English in user-facing copy.
- Every commit message ends with:
  `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`

---

### Task 1: Read real DAX from the Fabric model definition

**Files:**
- Create: `lib/modelDefinition.js`
- Test: `test/modelDefinition.test.js`

**Interfaces:**
- Consumes: nothing (calls `fetch` directly — a separate AAD resource from `lib/powerbi.js`'s Power BI REST calls, so it does not reuse that module's token cache).
- Produces:
  - `async fetchModelDefinition(credentials, { workspaceId, datasetId }, opts)` → `{ measures, columns, relationships }` or `null` on any failure. Never throws.
    - `opts` is `{ pollIntervalMs = 5000, maxPollMs = 90000 }` — production defaults; tests override both to keep runtime short while still exercising the real polling loop.
  - Shapes:
    - measure: `{ name, expression }` — only measures with a non-empty expression are included.
    - column: `{ name, table, expression }` — only *calculated* columns (`type === "calculated"` in TMSL) are included; an ordinary imported column contributes nothing.
    - relationship: `{ fromTable, fromColumn, toTable, toColumn, isActive, crossFilteringBehavior }`.
  - `clearFabricTokenCache()` — resets the module's cached Fabric AAD token; tests call this between cases so a token cached by one test cannot leak into the next.

- [ ] **Step 1: Write the failing tests**

```javascript
// test/modelDefinition.test.js
//
// Fabric's Get Semantic Model Definition API is a long-running operation on
// a different AAD resource (api.fabric.microsoft.com, not
// analysis.windows.net) from everything else this app calls, so every case
// here stubs global.fetch directly rather than going through lib/powerbi.js.
//
// The TMSL fixture below is trimmed from a live probe against a Fabric
// trial capacity: a real measure's expression, a real calculated column's
// expression, and a real relationship, plus the partitions/dataSources
// noise that must never survive extraction -- the whole reason this parses
// a whitelist instead of returning the decoded JSON as-is.

const test = require("node:test");
const assert = require("node:assert");

const {
  fetchModelDefinition,
  clearFabricTokenCache,
} = require("../lib/modelDefinition");

const CREDENTIALS = { tenantId: "t1", clientId: "c1", clientSecret: "s1" };

const BIM = {
  model: {
    tables: [
      {
        name: "Data",
        measures: [
          { name: "Number of Console", expression: "DISTINCTCOUNT(Data[Console])", formatString: "0" },
          { name: "Hidden Helper", expression: "" }, // no expression -- must be dropped
        ],
        columns: [
          { name: "Game", type: "column", dataType: "string" },
          { name: "Year", type: "calculated", expression: "YEAR(Data[Date])", dataType: "int64" },
        ],
        // The full Power Query/M source -- including, in the real probe, a
        // local file path. Present in the fixture specifically so a test can
        // assert it never reaches the returned shape.
        partitions: [
          {
            name: "Data",
            source: { type: "m", expression: "let Source = Csv.Document(File.Contents(\"C:\\\\Users\\\\someone\\\\data.csv\")) in Source" },
          },
        ],
      },
    ],
    relationships: [
      {
        name: "rel1",
        fromTable: "Data",
        fromColumn: "Date",
        toTable: "Date",
        toColumn: "Date",
        crossFilteringBehavior: "BothDirections",
      },
      {
        name: "rel2",
        fromTable: "Date",
        fromColumn: "Date",
        toTable: "LocalDateTable_x",
        toColumn: "Date",
        isActive: false,
      },
    ],
    // Never extracted, never referenced by any code in this module.
    roles: [{ name: "RestrictedRole" }],
    dataSources: [{ name: "SomeSource" }],
  },
};

function bimPart() {
  return {
    definition: {
      parts: [
        { path: "model.bim", payload: Buffer.from(JSON.stringify(BIM)).toString("base64") },
      ],
    },
  };
}

function fakeResponse({ status = 200, json, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json ?? {}),
    headers: { get: (name) => headers[name] ?? null },
  };
}

// A queue-based fetch stub: each test pushes exactly the responses its own
// call sequence needs, in order. Any call beyond the queue is a test bug,
// not a real network access, so it throws loudly rather than hanging.
function queueFetch(responses) {
  const queue = [...responses];
  return async () => {
    if (!queue.length) throw new Error("fetch called more times than the test expected");
    const next = queue.shift();
    return typeof next === "function" ? next() : next;
  };
}

let originalFetch;
test.beforeEach(() => {
  clearFabricTokenCache();
  originalFetch = global.fetch;
});
test.afterEach(() => {
  global.fetch = originalFetch;
});

test("a 200-immediate response is parsed straight away", async () => {
  global.fetch = queueFetch([
    fakeResponse({ json: { access_token: "tok", expires_in: 3600 } }), // AAD token
    fakeResponse({ status: 200, json: bimPart() }), // getDefinition
  ]);

  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  assert.deepEqual(got.measures, [{ name: "Number of Console", expression: "DISTINCTCOUNT(Data[Console])" }]);
});

test("a 202 long-running operation is polled until it succeeds", async () => {
  let pollCount = 0;
  global.fetch = async (url) => {
    if (String(url).includes("oauth2")) return fakeResponse({ json: { access_token: "tok", expires_in: 3600 } });
    if (String(url).includes("getDefinition")) {
      return fakeResponse({ status: 202, headers: { Location: "https://fabric.example/op/1" } });
    }
    if (String(url) === "https://fabric.example/op/1") {
      pollCount += 1;
      return fakeResponse({ status: 200, json: { status: pollCount < 2 ? "Running" : "Succeeded" } });
    }
    if (String(url) === "https://fabric.example/op/1/result") {
      return fakeResponse({ status: 200, json: bimPart() });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  const got = await fetchModelDefinition(
    CREDENTIALS,
    { workspaceId: "w1", datasetId: "d1" },
    { pollIntervalMs: 1, maxPollMs: 10_000 }
  );
  assert.deepEqual(got.columns, [{ name: "Year", table: "Data", expression: "YEAR(Data[Date])" }]);
  assert.ok(pollCount >= 2, "must have polled more than once before succeeding");
});

test("an operation that never succeeds within the ceiling resolves to null, not a hang", async () => {
  global.fetch = async (url) => {
    if (String(url).includes("oauth2")) return fakeResponse({ json: { access_token: "tok", expires_in: 3600 } });
    if (String(url).includes("getDefinition")) {
      return fakeResponse({ status: 202, headers: { Location: "https://fabric.example/op/2" } });
    }
    return fakeResponse({ status: 200, json: { status: "Running" } }); // never completes
  };

  const got = await fetchModelDefinition(
    CREDENTIALS,
    { workspaceId: "w1", datasetId: "d1" },
    { pollIntervalMs: 5, maxPollMs: 30 }
  );
  assert.equal(got, null);
});

test("a failed token request resolves to null", async () => {
  global.fetch = queueFetch([fakeResponse({ status: 401, json: { error: "invalid_client" } })]);
  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  assert.equal(got, null);
});

test("a non-200/202 response to getDefinition resolves to null", async () => {
  global.fetch = queueFetch([
    fakeResponse({ json: { access_token: "tok", expires_in: 3600 } }),
    fakeResponse({ status: 403, json: { error: "Forbidden" } }),
  ]);
  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  assert.equal(got, null);
});

test("missing workspaceId or datasetId resolves to null without calling fetch", async () => {
  global.fetch = async () => {
    throw new Error("fetch should never be called");
  };
  assert.equal(await fetchModelDefinition(CREDENTIALS, { workspaceId: null, datasetId: "d1" }), null);
  assert.equal(await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: null }), null);
});

test("a measure with no expression is dropped, not included as empty", async () => {
  global.fetch = queueFetch([
    fakeResponse({ json: { access_token: "tok", expires_in: 3600 } }),
    fakeResponse({ status: 200, json: bimPart() }),
  ]);
  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  assert.ok(!got.measures.some((m) => m.name === "Hidden Helper"));
});

test("an ordinary (non-calculated) column contributes nothing", async () => {
  global.fetch = queueFetch([
    fakeResponse({ json: { access_token: "tok", expires_in: 3600 } }),
    fakeResponse({ status: 200, json: bimPart() }),
  ]);
  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  assert.ok(!got.columns.some((c) => c.name === "Game"));
});

test("relationships carry crossFilteringBehavior and a defaulted isActive", async () => {
  global.fetch = queueFetch([
    fakeResponse({ json: { access_token: "tok", expires_in: 3600 } }),
    fakeResponse({ status: 200, json: bimPart() }),
  ]);
  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  assert.deepEqual(got.relationships, [
    { fromTable: "Data", fromColumn: "Date", toTable: "Date", toColumn: "Date", isActive: true, crossFilteringBehavior: "BothDirections" },
    { fromTable: "Date", fromColumn: "Date", toTable: "LocalDateTable_x", toColumn: "Date", isActive: false, crossFilteringBehavior: null },
  ]);
});

test("partitions, dataSources and roles never reach the returned shape", async () => {
  global.fetch = queueFetch([
    fakeResponse({ json: { access_token: "tok", expires_in: 3600 } }),
    fakeResponse({ status: 200, json: bimPart() }),
  ]);
  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  const serialised = JSON.stringify(got);
  assert.ok(!serialised.includes("Csv.Document"), "the M/Power Query source must never survive extraction");
  assert.ok(!serialised.includes("SomeSource"));
  assert.ok(!serialised.includes("RestrictedRole"));
  assert.deepEqual(Object.keys(got).sort(), ["columns", "measures", "relationships"]);
});

test("a malformed model.bim part resolves to null", async () => {
  global.fetch = queueFetch([
    fakeResponse({ json: { access_token: "tok", expires_in: 3600 } }),
    fakeResponse({
      status: 200,
      json: { definition: { parts: [{ path: "model.bim", payload: Buffer.from("not json").toString("base64") }] } },
    }),
  ]);
  const got = await fetchModelDefinition(CREDENTIALS, { workspaceId: "w1", datasetId: "d1" });
  assert.equal(got, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/modelDefinition.test.js`
Expected: FAIL — `Cannot find module '../lib/modelDefinition'`

- [ ] **Step 3: Write the module**

```javascript
// lib/modelDefinition.js
//
// Real measure and calculated-column DAX, read from Fabric's Get Semantic
// Model Definition API (?format=TMSL) -- a different mechanism entirely
// from executeQueries (lib/powerbi.js), which redacts Expression
// unconditionally regardless of permissions. This requires Fabric API
// permissions (Dataset.Read.All / SemanticModel.Read.All) and a workspace
// on Fabric/Premium/PPU capacity; established by probe against a Fabric
// trial capacity before any of this was built.
//
// TMSL (requested via ?format=TMSL) returns a single model.bim JSON file --
// the documented Analysis Services tabular schema -- rather than the
// default TMDL text folder, so this needs no custom parser: just a JSON
// walk with a field whitelist.

const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
const FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1";
const AAD_TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

// Deliberately separate from lib/powerbi.js's token cache -- Fabric and the
// classic Power BI REST API are different AAD resources, and caching one
// token under the other's key would silently send the wrong audience.
let cachedToken = null; // { accessToken, expiresAt }

function clearFabricTokenCache() {
  cachedToken = null;
}

async function getFabricToken({ tenantId, clientId, clientSecret }) {
  if (!tenantId || !clientId || !clientSecret) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: FABRIC_SCOPE,
  });

  let res;
  try {
    res = await fetch(AAD_TOKEN_URL(tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const json = await res.json();
  if (!json.access_token) return null;
  cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.accessToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls a Fabric long-running-operation until it succeeds, fails, or the
// ceiling is reached -- this runs synchronously inside an admin's "Sync
// from model" click, which already does several sequential DAX queries, so
// it must have a hard ceiling rather than polling forever.
async function pollOperation(location, token, { pollIntervalMs, maxPollMs }) {
  const deadline = Date.now() + maxPollMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let res;
    try {
      res = await fetch(location, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const json = await res.json();
    if (json.status === "Succeeded") {
      let resultRes;
      try {
        resultRes = await fetch(`${location}/result`, { headers: { Authorization: `Bearer ${token}` } });
      } catch {
        return null;
      }
      return resultRes.ok ? resultRes.json() : null;
    }
    if (json.status === "Failed") return null;
    // "Running" / "NotStarted" -- keep polling.
  }
  return null;
}

function decodeBim(parts) {
  const part = Array.isArray(parts) ? parts.find((p) => p.path === "model.bim") : null;
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Only these fields ever leave this function. Everything else in the TMSL
// payload -- partitions (the full Power Query/M source, which can carry a
// local file path or connection details), dataSources, roles, perspectives
// -- is discarded right here, not merely unused by a caller downstream.
function extractWhitelist(bim) {
  const tables = bim?.model?.tables;
  if (!Array.isArray(tables)) return { measures: [], columns: [], relationships: [] };

  const measures = [];
  const columns = [];
  for (const t of tables) {
    for (const m of t.measures || []) {
      if (m?.name && m?.expression) measures.push({ name: m.name, expression: m.expression });
    }
    for (const c of t.columns || []) {
      if (c?.type === "calculated" && c?.name && c?.expression) {
        columns.push({ name: c.name, table: t.name, expression: c.expression });
      }
    }
  }

  const relationships = (bim?.model?.relationships || [])
    .filter((r) => r?.fromTable && r?.toTable)
    .map((r) => ({
      fromTable: r.fromTable,
      fromColumn: r.fromColumn ?? null,
      toTable: r.toTable,
      toColumn: r.toColumn ?? null,
      isActive: r.isActive !== false,
      crossFilteringBehavior: r.crossFilteringBehavior ?? null,
    }));

  return { measures, columns, relationships };
}

/**
 * Reads real DAX from the model's own Fabric definition. Resolves to null
 * on any failure -- no Fabric permission, a non-Fabric-capacity workspace,
 * an LRO that never completes within the ceiling, a malformed response.
 * Never throws: a model that will not describe itself this way must not
 * take the sync down with it, since the INFO.VIEW read is what actually
 * matters for chat to keep working.
 */
async function fetchModelDefinition(
  credentials,
  { workspaceId, datasetId },
  { pollIntervalMs = 5000, maxPollMs = 90_000 } = {}
) {
  if (!workspaceId || !datasetId) return null;

  try {
    const token = await getFabricToken(credentials);
    if (!token) return null;

    const url = `${FABRIC_API_BASE}/workspaces/${workspaceId}/semanticModels/${datasetId}/getDefinition?format=TMSL`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

    let result;
    if (res.status === 200) {
      result = await res.json();
    } else if (res.status === 202) {
      const location = res.headers.get("Location");
      if (!location) return null;
      result = await pollOperation(location, token, { pollIntervalMs, maxPollMs });
    } else {
      return null;
    }
    if (!result) return null;

    const bim = decodeBim(result.definition?.parts);
    if (!bim) return null;
    return extractWhitelist(bim);
  } catch (err) {
    console.error("[model definition] fetch failed:", err.message);
    return null;
  }
}

module.exports = { fetchModelDefinition, clearFabricTokenCache };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/modelDefinition.test.js`
Expected: PASS, 11 tests

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add lib/modelDefinition.js test/modelDefinition.test.js
git commit -m "feat: read real measure and calculated-column DAX from Fabric

executeQueries redacts Expression unconditionally -- no permission fixes
that. Get Semantic Model Definition (?format=TMSL) is a different
mechanism, confirmed by probe to return real DAX as flat JSON on a Fabric
trial capacity. Only a narrow field whitelist ever leaves this module: the
Power Query/M source, data sources, roles and perspectives are discarded
at extraction, not merely unused downstream.

The long-running-operation poll has a hard ceiling so an admin's sync
click cannot hang forever; exceeding it resolves to null like any other
acquisition failure.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Merge real DAX into the existing metadata shape

**Files:**
- Modify: `lib/modelMetadata.js`
- Modify: `test/modelMetadata.test.js`

**Interfaces:**
- Consumes: the `{ measures, columns, relationships }` shape from Task 1's `fetchModelDefinition`.
- Produces:
  - `normalise()`'s column shape gains an `expression` field (`null` until merged) — same convention `measures[].expression` already uses.
  - `normalise()`'s relationship shape gains a `crossFilteringBehavior` field (`null` until merged).
  - `mergeDefinition(metadata, definition)` → a new metadata object with `expression`/`crossFilteringBehavior` overlaid by name match; `definition` of `null` returns `metadata` completely unchanged (same reference, so a caller can compare by identity if it ever needs to).

- [ ] **Step 1: Update the existing normalisation test for the new column field**

In `test/modelMetadata.test.js`, find the test `"the fields the card needs survive normalisation"` and update its expected object:

```javascript
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
```

- [ ] **Step 2: Write the failing tests for `mergeDefinition`**

Append to `test/modelMetadata.test.js`:

```javascript
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

test("mergeDefinition never mutates its inputs", () => {
  const definition = {
    measures: [{ name: "Number of Console", expression: "DISTINCTCOUNT(Data[Console])" }],
    columns: [],
    relationships: [],
  };
  mergeDefinition(METADATA, definition);
  assert.equal(METADATA.measures[0].expression, null, "the original metadata object must be untouched");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/modelMetadata.test.js`
Expected: FAIL — the updated field-shape assertion fails (missing `expression`); `mergeDefinition is not a function`.

- [ ] **Step 4: Add the `expression`/`crossFilteringBehavior` fields to `normalise()`**

In `lib/modelMetadata.js`, in the `columns` map inside `normalise()`, add `expression: null` after `description: val(r, "Description")`:

```javascript
    .map((r) => ({
      name: val(r, "Name"),
      table: val(r, "Tbl"),
      dataType: val(r, "DataType"),
      formatString: val(r, "FormatString"),
      summarizeBy: val(r, "SummarizeBy"),
      description: val(r, "Description"),
      // Always null from this acquisition path -- executeQueries never
      // requests it, since it would be redacted anyway. Set by
      // mergeDefinition() when a Fabric read succeeds.
      expression: null,
    }));
```

In the `relationships` map, add `crossFilteringBehavior: null` after `toTable: val(r, "ToTable")`:

```javascript
    .map((r) => ({
      text: val(r, "Rel"),
      isActive: val(r, "IsActive"),
      fromTable: val(r, "FromTable"),
      toTable: val(r, "ToTable"),
      // Always null from this acquisition path -- INFO.VIEW.RELATIONSHIPS
      // has no such field. Set by mergeDefinition() when a Fabric read
      // succeeds.
      crossFilteringBehavior: null,
    }));
```

- [ ] **Step 5: Add `mergeDefinition`**

In `lib/modelMetadata.js`, above `module.exports`:

```javascript
/**
 * Overlays real DAX (from fetchModelDefinition) onto normalised metadata,
 * matching by name -- table+name for columns and relationships, since names
 * alone aren't unique across tables. A null definition returns metadata
 * completely unchanged: a Fabric-fetch failure alongside a successful
 * INFO.VIEW read must look exactly like a sync that never had this feature.
 */
function mergeDefinition(metadata, definition) {
  if (!definition) return metadata;

  const measureExpr = new Map(definition.measures.map((m) => [m.name, m.expression]));
  const columnExpr = new Map(definition.columns.map((c) => [`${c.table}::${c.name}`, c.expression]));
  const relBehavior = new Map(
    definition.relationships.map((r) => [`${r.fromTable}::${r.toTable}`, r.crossFilteringBehavior])
  );

  return {
    ...metadata,
    measures: metadata.measures.map((m) => ({
      ...m,
      expression: measureExpr.get(m.name) ?? m.expression,
    })),
    columns: metadata.columns.map((c) => ({
      ...c,
      expression: columnExpr.get(`${c.table}::${c.name}`) ?? c.expression,
    })),
    relationships: metadata.relationships.map((r) => ({
      ...r,
      crossFilteringBehavior: relBehavior.get(`${r.fromTable}::${r.toTable}`) ?? r.crossFilteringBehavior,
    })),
  };
}
```

Update the export line:

```javascript
module.exports = { fetchModelMetadata, normalise, mergeDefinition };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/modelMetadata.test.js`
Expected: PASS, 19 tests

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add lib/modelMetadata.js test/modelMetadata.test.js
git commit -m "feat: merge real DAX onto the model metadata shape

Columns gain the same expression field measures already had (always null
from this acquisition path -- executeQueries would redact it anyway).
mergeDefinition() overlays real values from a Fabric read by name --
table+name for columns and relationships, since names alone aren't unique
across tables. A null definition returns metadata completely unchanged, so
a Fabric-fetch failure alongside a successful INFO.VIEW read looks exactly
like a sync that never had this feature.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the Fabric read into the sync route

**Files:**
- Modify: `routes/admin.js`

**Interfaces:**
- Consumes: `fetchModelDefinition` (Task 1), `mergeDefinition` (Task 2).
- Produces: `POST /api/admin/reports/:id/sync-model`'s success response gains two fields on `counts`: `measuresWithExpression`, `calculatedColumnsWithExpression`. No other field changes shape.

- [ ] **Step 1: Add the requires**

In `routes/admin.js`, change:

```javascript
const { fetchModelMetadata } = require("../lib/modelMetadata");
```

to:

```javascript
const { fetchModelMetadata, mergeDefinition } = require("../lib/modelMetadata");
const { fetchModelDefinition } = require("../lib/modelDefinition");
```

- [ ] **Step 2: Extend the sync route**

Replace the body of `router.post("/reports/:id/sync-model", ...)` from after the `datasetId` check through the `setModelMetadata`/`reconcile` calls:

```javascript
  const settings = await getSettings();
  const credentials = {
    tenantId: settings.pbiTenantId,
    clientId: settings.pbiClientId,
    clientSecret: settings.pbiClientSecret,
  };

  const rawMetadata = await fetchModelMetadata(credentials, {
    workspaceId: report.workspaceId,
    datasetId: report.datasetId,
  });

  // Deliberately not written: a failed refresh must not leave the report
  // worse off than it was before someone pressed the button.
  if (!rawMetadata) {
    return res.status(502).json({
      error: "Couldn't read this model's metadata. The service principal may not have access to it.",
    });
  }

  // Best-effort: no Fabric permission, a non-Fabric-capacity workspace, or
  // an LRO that times out must not fail a sync whose INFO.VIEW read already
  // succeeded -- that result is worth keeping on its own.
  const definition = await fetchModelDefinition(credentials, {
    workspaceId: report.workspaceId,
    datasetId: report.datasetId,
  });
  const metadata = mergeDefinition(rawMetadata, definition);

  const saved = await setModelMetadata(report.id, metadata);
  const { described, undescribed, unknownReferences } = reconcile(metadata, saved);

  res.json({
    syncedAt: saved.modelMetadataSyncedAt,
    counts: {
      tables: metadata.tables.length,
      measures: metadata.measures.length,
      columns: metadata.columns.length,
      relationships: metadata.relationships.length,
      measuresWithExpression: metadata.measures.filter((m) => m.expression).length,
      calculatedColumnsWithExpression: metadata.columns.filter((c) => c.expression).length,
    },
    reconciliation: {
      describedCount: described.length,
      undescribed: undescribed.map((u) => `${u.kind === "measure" ? "[" + u.name + "]" : "'" + u.table + "'[" + u.name + "]"}`),
      unknownReferences,
    },
  });
```

Note: the existing `if (!report.datasetId) { ... }` block above this stays exactly as it is — only the code after it changes.

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS — no test exercises this route directly (matching the existing convention: the route has no dedicated test file, per the prior sync-route task), but nothing else should regress.
Run: `npm run check`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add routes/admin.js
git commit -m "feat: enrich a report's sync with real DAX from Fabric

Best-effort: the existing INFO.VIEW read still gates success or failure
exactly as before. A Fabric read that fails for any reason -- no
permission, a non-Fabric-capacity workspace, a timeout -- leaves a sync
that succeeds precisely as it did before this feature existed. The
response's counts gain two fields so an admin can tell a working
enrichment from a silent gap without checking server logs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Render real DAX and relationship direction in the card

**Files:**
- Modify: `lib/modelCard.js`
- Modify: `test/modelCard.test.js`

**Interfaces:**
- Consumes: the `expression`/`crossFilteringBehavior` fields from Task 2.
- Produces: `render(metadata, report)` — unchanged signature. A measure or calculated column with a non-null `expression` shows it; a relationship with `crossFilteringBehavior === "BothDirections"` gains a `(bidirectional)` tag alongside the existing `(inactive)` tag.

- [ ] **Step 1: Write the failing tests**

Append to `test/modelCard.test.js`:

```javascript
test("a measure with a real expression shows it under its name, above the description", () => {
  const withExpr = {
    ...META,
    measures: META.measures.map((m) =>
      m.name === "1_ Total Interactions" ? { ...m, expression: "COUNTROWS(DataTable)" } : m
    ),
  };
  const card = render(withExpr, { measuresDescription: "[1_ Total Interactions] counts every ticket." });
  const nameIdx = card.indexOf("[1_ Total Interactions]");
  const exprIdx = card.indexOf("= COUNTROWS(DataTable)");
  const descIdx = card.indexOf("counts every ticket");
  assert.ok(nameIdx !== -1 && exprIdx !== -1 && descIdx !== -1);
  assert.ok(nameIdx < exprIdx && exprIdx < descIdx, "expression sits between the name/type line and the description");
});

test("a measure with no expression renders exactly as before -- no blank formula line", () => {
  const card = render(META, { measuresDescription: "[1_ Total Interactions] counts every ticket." });
  assert.ok(!card.includes("= "), "no expression means no '= ...' line at all");
});

test("a calculated column's expression renders the same way", () => {
  const withCalc = {
    ...META,
    columns: [...META.columns, { name: "Year", table: "DataTable", dataType: "Int64", formatString: null, summarizeBy: "Sum", description: null, expression: "YEAR(DataTable[Date])" }],
  };
  const card = render(withCalc, {});
  assert.ok(card.includes("= YEAR(DataTable[Date])"));
});

test("a bidirectional relationship gets a (bidirectional) tag", () => {
  const withRel = {
    ...META,
    relationships: [
      { text: "'DataTable'[X] *[<->]* 'Other'[Y]", isActive: true, fromTable: "DataTable", toTable: "Other", crossFilteringBehavior: "BothDirections" },
    ],
  };
  const card = render(withRel, {});
  assert.match(card, /\(bidirectional\)/);
});

test("an inactive AND bidirectional relationship shows both tags together", () => {
  const withRel = {
    ...META,
    relationships: [
      { text: "'DataTable'[X] *[<->]* 'Other'[Y]", isActive: false, fromTable: "DataTable", toTable: "Other", crossFilteringBehavior: "BothDirections" },
    ],
  };
  const card = render(withRel, {});
  assert.match(card, /\(inactive, bidirectional\)/);
});

test("a one-directional active relationship keeps rendering with no tag, as before", () => {
  const withRel = {
    ...META,
    relationships: [
      { text: "'DataTable'[X] *[<-]1 'Other'[Y]", isActive: true, fromTable: "DataTable", toTable: "Other", crossFilteringBehavior: null },
    ],
  };
  const card = render(withRel, {});
  assert.ok(card.includes("'DataTable'[X] *[<-]1 'Other'[Y]") && !card.includes("(inactive") && !card.includes("bidirectional"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/modelCard.test.js`
Expected: FAIL — the new assertions fail (no expression line, no bidirectional tag).

- [ ] **Step 3: Implement**

In `lib/modelCard.js`, inside the `section` helper (used for MEASURES), add the expression line between the name/type line and the description lines:

```javascript
  const section = (title, items, kind) => {
    if (!items?.length) return;
    out.push(`\n${title}`);
    for (const item of items) {
      const obj = { kind, name: item.name, table: item.table };
      out.push(`  ${qualified(obj)}  ${describeType(item)}`.trimEnd());
      if (item.expression) out.push(`      = ${item.expression}`);
      const lines = linesFor.get(`${kind}:${item.name}`);
      if (lines) lines.forEach((l) => out.push(`      ${l}`));
      else out.push(`      (no description)`);
    }
  };
```

In the COLUMNS budget-truncation loop, add the same line right after building `entry`'s header:

```javascript
  for (const col of metadata.columns || []) {
    const obj = { kind: "column", name: col.name, table: col.table };
    const entry = [`  ${qualified(obj)}  ${describeType(col)}`.trimEnd()];
    if (col.expression) entry.push(`      = ${col.expression}`);
    const lines = linesFor.get(`column:${col.name}`);
    if (lines) lines.forEach((l) => entry.push(`      ${l}`));
    else entry.push(`      (no description)`);
```

Replace the RELATIONSHIPS block's single-tag logic with a general tag list, so `(inactive)` and `(bidirectional)` combine correctly instead of one overwriting the other:

```javascript
  if (metadata.relationships?.length) {
    out.push("\nRELATIONSHIPS");
    for (const r of metadata.relationships) {
      const tags = [];
      if (r.isActive === false) tags.push("inactive");
      if (r.crossFilteringBehavior === "BothDirections") tags.push("bidirectional");
      out.push(`  ${r.text}${tags.length ? `  (${tags.join(", ")})` : ""}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/modelCard.test.js`
Expected: PASS

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add lib/modelCard.js test/modelCard.test.js
git commit -m "feat: show real DAX and bidirectional filtering in the card

A measure or calculated column with a real expression shows it right
where an admin's own description already sits, so the AI sees exactly how
existing logic is computed rather than only its name and type. A
bidirectional relationship changes what DAX is correct to write --
ambiguous filter propagation, when USERELATIONSHIP is actually needed --
so it gets a tag regardless of whether the admin ever thinks to mention
it. The two relationship tags now combine instead of one overwriting the
other.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Show the enrichment result in admin

**Files:**
- Modify: `public/admin.js`

**Interfaces:**
- Consumes: `counts.measuresWithExpression` / `counts.calculatedColumnsWithExpression` from Task 3's route response.

- [ ] **Step 1: Extend the sync success panel**

In `public/admin.js`, inside the `$("sync-model")` click handler, find the `rows` array construction and add two lines after the existing counts line:

```javascript
      const rows = [
        `<div><strong>${r.counts.tables}</strong> tables, <strong>${r.counts.measures}</strong> measures, ` +
          `<strong>${r.counts.columns}</strong> columns, <strong>${r.counts.relationships}</strong> relationships.</div>`,
        `<div>${r.counts.measuresWithExpression} of ${r.counts.measures} measures have real DAX read from the model.</div>`,
        `<div>${r.counts.calculatedColumnsWithExpression} calculated column DAX definitions read from the model.</div>`,
        `<div>${r.reconciliation.describedCount} described by your notes.</div>`,
      ];
```

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: PASS
Run: `npm run check`
Expected: exit 0
Run: `node --check public/admin.js`
Expected: exit 0

The browser behaviour cannot be exercised here — say so plainly in the report rather than claiming a check that was not run.

- [ ] **Step 3: Commit**

```bash
git add public/admin.js
git commit -m "feat: show how much real DAX a sync actually found

Distinguishes a working enrichment from a silent gap -- a non-Fabric
workspace or a missing permission now shows as '0 of N measures' right in
the panel an admin already has open, rather than requiring a look at
server logs to tell the two apart.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document it**

In `README.md`, extend the existing paragraph about the semantic model sync (currently ending "...and the sync reports anything your notes mention that the model does not actually contain."):

```markdown
Each report can also be synced against its semantic model from `/admin`,
which reads the tables, columns, measures, format strings and relationships
straight from Power BI. Those are merged with the descriptions typed in admin
into one card the AI is given, so it works from exact names rather than
remembered ones — and the sync reports anything your notes mention that the
model does not actually contain. Where the tenant has a Fabric-capable
workspace and the service principal has been granted Fabric API permissions
(`Dataset.Read.All` / `SemanticModel.Read.All`), the sync also reads each
measure's and calculated column's real DAX definition, so the AI writes
queries grounded in the model's actual formulas rather than only its names
and types. This is best-effort — a workspace without Fabric capacity, or a
service principal without those permissions, still gets a successful sync
with everything except the real DAX.
```

In the project-structure block, after `lib/modelCard.js`:

```markdown
lib/modelDefinition.js                # Reads real measure/column DAX via the Fabric API
```

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: PASS — every suite.
Run: `npm run check`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the Fabric DAX enrichment

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-review notes

Checked against the spec:

- **Acquisition** — Task 1. `?format=TMSL`, the LRO poll with a hard ceiling, and the field whitelist (measures with a non-empty expression, calculated columns only, relationship fields) all match the spec exactly. The never-throws contract is tested for every failure path named in the spec: no Fabric permission (token failure), non-Fabric-capacity workspace (non-200/202 response), an LRO timeout, and a malformed response.
- **Discarding the M-query source** — Task 1's fixture deliberately includes `partitions` with a fake local file path and asserts it never appears in the output, matching the spec's explicit requirement that this is discarded at extraction, not merely unused.
- **Merge** — Task 2. `mergeDefinition`'s table+name matching for columns and relationships (not name alone) is spec'd explicitly, as is the "null definition leaves metadata unchanged" contract Task 3 depends on for its best-effort behaviour.
- **New column field** — Task 2 also updates the one existing test whose exact-shape assertion would otherwise break, per the spec's note that a pre-feature metadata row (no `expression` key on its columns) must render identically to one saved after — Task 4's tests confirm this on the rendering side too (`item.expression` read defensively, no new field the renderer doesn't already guard).
- **Route wiring and best-effort behaviour** — Task 3. A Fabric failure never fails the sync when `fetchModelMetadata` already succeeded; the two new count fields are additive to the existing response shape, per spec.
- **Rendering** — Task 4. Expression line placement (between name/type and description), the `(bidirectional)` tag logic, and the tag-combination fix (so `(inactive)` and `(bidirectional)` don't overwrite each other) all match the spec's example card and its relationship-tagging rule.
- **Admin visibility** — Task 5, the two new lines in the existing panel, per spec's "an admin can see ... rather than needing server logs."
- **Documentation** — Task 6.

Type consistency checked: `fetchModelDefinition`'s returned shape (Task 1) is exactly what `mergeDefinition` reads (Task 2); `mergeDefinition`'s returned metadata shape is exactly what `render()` already expects (Task 4) plus the two new fields; the route's `counts` object (Task 3) matches the two field names Task 5's UI reads (`measuresWithExpression`, `calculatedColumnsWithExpression`) exactly.

Not covered, deliberately, per the spec's "Not in this design": a model-review/audit feature, relationship reconciliation between the two acquisition sources beyond the additive `crossFilteringBehavior` tag, RLS roles, perspectives, hierarchies, and calculation groups.
