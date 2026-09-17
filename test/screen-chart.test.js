// test/screen-chart.test.js
//
// Charts are built in code, never by the model. The escalation path used to
// fall back to a CHART: line the model emitted unprompted whenever the query
// failed, which is the one route by which a model-authored spec could still
// reach the renderer.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function stub(rel, exports) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

let queryResult = { rows: [] };
stub("lib/powerbi", {
  executeQuery: async () => {
    if (queryResult.error) throw new Error(queryResult.error);
    return queryResult.rows;
  },
});
stub("lib/answer/dax", { generateDaxFor: async () => ({ dax: "EVALUATE Sales", format: null }) });

const screen = require(path.join(ROOT, "lib/answer/screen.js"));

const MODEL_CHART = `CHART: ${JSON.stringify({ type: "donut", labels: ["a"], values: [1] })}`;

// The first stream is the screen read, the second the composed answer.
function provider(replies) {
  const queue = [...replies];
  return {
    completeStream: async (_request, onDelta) => {
      const text = queue.shift() || "";
      onDelta(text);
      return text;
    },
  };
}

function ctx(replies) {
  return {
    report: { id: "r1", workspaceId: "w", datasetId: "d", schemaDescription: "s" },
    settings: { pbiTenantId: "t", pbiClientId: "c", pbiClientSecret: "s" },
    provider: provider(replies),
    question: "how did 2015 compare?",
    state: { pageName: "Overview", visuals: [] },
    history: [],
    aborted: () => false,
  };
}

test("a model-authored CHART line never becomes the chart when the query failed", async () => {
  queryResult = { error: "dataset unavailable" };
  const result = await screen.run(
    ctx(["NEED_DATA: 2015 sales", `Couldn't retrieve it.\n${MODEL_CHART}`]),
    () => {}
  );

  assert.equal(result.chart, null, "no chart at all is better than one the model invented");
  assert.ok(!result.answer.includes("CHART:"), "but the line is still stripped from the prose");
});

test("a model-authored CHART line never overrides the one built from the rows", async () => {
  queryResult = { rows: [{ "Data[Genre]": "Action", "[Sales]": 10 }, { "Data[Genre]": "Sports", "[Sales]": 8 }] };
  const result = await screen.run(
    ctx(["NEED_DATA: 2015 sales", `Action leads.\n${MODEL_CHART}`]),
    () => {}
  );

  assert.equal(result.chart.type, "bar", "the chart is the one buildChartSpec made from the rows");
  assert.deepEqual(result.chart.labels, ["Action", "Sports"]);
  assert.ok(Array.isArray(result.chart.validTypes) && result.chart.validTypes.length);
});
