// test/screen-grounding.test.js
//
// The escalation path shares the DAX-writing prompt with the data path, but
// never ran the same grounding check on the result -- a breakdown question
// that came back ungrouped ran straight to Power BI and returned raw rows
// with no correction attempt, unlike the data path's own escalation.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function stub(rel, exports) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

let daxCalls = [];
let daxReplies = [];
stub("lib/answer/dax", {
  generateDaxFor: async (_report, _provider, messages) => {
    const reply = daxReplies[daxCalls.length] || daxReplies[daxReplies.length - 1];
    daxCalls.push(messages);
    return reply;
  },
});

stub("lib/powerbi", {
  executeQuery: async () => [
    { "Data[Genre]": "Action", "[Sales]": 10 },
    { "Data[Genre]": "Sports", "[Sales]": 8 },
  ],
});

const screen = require(path.join(ROOT, "lib/answer/screen.js"));

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

function ctx(streamReplies) {
  return {
    report: { id: "r1", workspaceId: "w", datasetId: "d", schemaDescription: "s" },
    settings: { pbiTenantId: "t", pbiClientId: "c", pbiClientSecret: "s" },
    provider: provider(streamReplies),
    question: "sales by genre",
    state: { pageName: "Overview", visuals: [] },
    history: [],
    aborted: () => false,
  };
}

test.beforeEach(() => {
  daxCalls = [];
  daxReplies = ["EVALUATE 'Data'", "EVALUATE SUMMARIZECOLUMNS('Data'[Genre], \"Sales\", [Sales])"];
});

test("an ungrouped breakdown query is regenerated before it ever reaches Power BI", async () => {
  await screen.run(ctx(["NEED_DATA: sales by genre", "Action leads."]), () => {});

  assert.equal(daxCalls.length, 2, "the ungrouped first attempt triggers exactly one correction");
  const correctionPrompt = daxCalls[1].map((m) => m.content).join("\n");
  assert.match(correctionPrompt, /does not answer the question/i);
  assert.match(correctionPrompt, /group|aggregat/i);
});

test("a query that already groups is never sent back for correction", async () => {
  daxReplies = ["EVALUATE SUMMARIZECOLUMNS('Data'[Genre], \"Sales\", [Sales])"];
  await screen.run(ctx(["NEED_DATA: sales by genre", "Action leads."]), () => {});

  assert.equal(daxCalls.length, 1, "an already-grouped query needs no correction round trip");
});
