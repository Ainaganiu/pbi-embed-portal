// test/authoring-cache.test.js
//
// The authoring path never cached at all -- every "how do I write a measure
// for X" repeated the full round trip, including the live validation query,
// even for the exact same question in the exact same conversation.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function stub(rel, exports) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

let queryCalls = 0;
stub("lib/powerbi", {
  executeQuery: async () => {
    queryCalls += 1;
    return [{ Result: 42 }];
  },
});

const llmCache = require(path.join(ROOT, "lib/llmCache.js"));
const authoring = require(path.join(ROOT, "lib/answer/authoring.js"));

function providerCounting() {
  const state = { calls: 0 };
  state.provider = {
    complete: async () => {
      state.calls += 1;
      return JSON.stringify({
        answer: "Use DIVIDE.",
        dax: "DIVIDE([Wins], [Games])",
        testTable: "Games",
        followUps: [],
      });
    },
  };
  return state;
}

function ctx(provider, history = []) {
  return {
    report: { id: "r-auth", workspaceId: "w", datasetId: "d", schemaDescription: "s" },
    settings: {},
    provider,
    question: "how do I write a win rate measure",
    history,
    aborted: () => false,
  };
}

test.beforeEach(() => {
  llmCache.clear();
  queryCalls = 0;
});

test("a repeated authoring question in the same conversation hits cache", async () => {
  const state = providerCounting();
  const first = await authoring.run(ctx(state.provider), () => {});
  const second = await authoring.run(ctx(state.provider), () => {});

  assert.equal(state.calls, 1, "the model is asked only once");
  assert.equal(queryCalls, 1, "the live validation runs only once");
  assert.equal(second.answer, first.answer);
  assert.equal(second.cached, true);
});

test("a different conversation asking the same words does not share the cache", async () => {
  const state = providerCounting();
  await authoring.run(ctx(state.provider, []), () => {});
  await authoring.run(
    ctx(state.provider, [{ role: "user", content: "earlier, unrelated turn" }]),
    () => {}
  );

  assert.equal(state.calls, 2, "different conversations are asked separately");
});
