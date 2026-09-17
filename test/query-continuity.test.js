// test/query-continuity.test.js
//
// The screen and authoring pipelines both pass prior turns into their
// composing call; the query pipeline's composing call was the one place that
// wrote the narrative answer with no memory of the conversation at all -- a
// genuine follow-up like "and 2022?" got a technically-correct but
// context-blind answer, with nothing tying it back to what was just said.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function stub(rel, exports) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

stub("lib/powerbi", {
  executeQuery: async () => [{ "Data[Genre]": "Action", "[Sales]": 10 }],
});

const query = require(path.join(ROOT, "lib/answer/query.js"));

function providerRecording(daxReply) {
  const calls = [];
  return {
    calls,
    // The composing call is the one identifiable feature every DAX call
    // lacks: it asks for JSON. Picking it out by that, rather than by call
    // order, survives a grounding or Power BI retry inserting an extra DAX
    // call in between.
    complete: async (request) => {
      calls.push(request);
      if (request.json) return JSON.stringify({ answer: "Sales rose.", intent: null, followUps: [] });
      return daxReply;
    },
  };
}

function ctx(provider, history) {
  return {
    report: { id: "r-continuity", workspaceId: "w", datasetId: "d", schemaDescription: "s" },
    settings: {},
    provider,
    // No year or other grounding trigger, so exactly one DAX call precedes
    // the composing call -- the thing under test.
    question: "sales by genre",
    history,
    aborted: () => false,
  };
}

function composingCallFrom(calls) {
  const found = calls.find((c) => c.json);
  assert.ok(found, "the composing call (the one JSON request) must have happened");
  return found;
}

test("the composing call carries prior turns, same as the other two pipelines", async () => {
  const history = [
    { role: "user", content: "sales by genre in 2021" },
    { role: "assistant", content: "Action led with 1,200." },
  ];
  const provider = providerRecording("EVALUATE Sales");
  await query.run(ctx(provider, history), () => {});

  const composingCall = composingCallFrom(provider.calls);
  assert.ok(
    composingCall.messages.some((m) => m.role === "assistant" && m.content === "Action led with 1,200."),
    "the composing call must see what the previous turn actually said"
  );
});

test("a standalone question with no history sends just the current turn", async () => {
  const provider = providerRecording("EVALUATE Sales");
  await query.run(ctx(provider, []), () => {});

  const composingCall = composingCallFrom(provider.calls);
  assert.equal(
    composingCall.messages.filter((m) => m.role === "assistant").length,
    0,
    "no history means nothing to prepend"
  );
});
