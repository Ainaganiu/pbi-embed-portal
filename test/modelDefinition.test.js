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
