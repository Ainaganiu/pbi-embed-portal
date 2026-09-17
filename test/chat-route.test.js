// Drives the real routes/chat.js over real HTTP with stubbed dependencies.
//
// Real HTTP matters here: the cancellation bug this file was written for --
// a listener on the REQUEST, which Node fires when the body finishes being
// read rather than when the client goes away -- is invisible to a fake req/res
// and was invisible to the suite because nothing exercised a disconnect.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const express = require("express");

const ROOT = path.join(__dirname, "..");

function stub(rel, exports) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

// routes/chat.js destructures its dependencies at load, so behaviour has to
// vary through these mutable hooks rather than by re-stubbing per test.
const hooks = { beforeRoute: null, run: null };
let routeReply = { path: "query", focusVisual: null, confidence: "high", reason: "stub" };
let providerShape = { complete: async () => "text" };
let lastProvider = null;
const calls = [];

stub("lib/settings", {
  getSettings: async () => ({ llmProvider: "stub", llmApiKey: "k", llmModel: "m", llmApiBase: null }),
  getReport: async (id) => (id === "missing" ? null : { id, datasetId: "d", schemaDescription: "s" }),
});
stub("lib/llm", { getProvider: () => providerShape });
stub("lib/route", {
  chooseRoute: async (provider) => {
    lastProvider = provider;
    if (hooks.beforeRoute) await hooks.beforeRoute();
    return routeReply;
  },
});

function pipeline(name) {
  return {
    async run(ctx, emit) {
      calls.push({ name, ctx });
      if (hooks.run) return hooks.run(name, ctx, emit);
      emit({ delta: name });
      return { answer: name };
    },
  };
}
stub("lib/answer/screen", pipeline("screen"));
stub("lib/answer/query", pipeline("query"));
stub("lib/answer/authoring", pipeline("authoring"));

const chatRouter = require(path.join(ROOT, "routes/chat.js"));

const app = express();
app.use(express.json());
app.use("/api/chat", chatRouter);

let server, base;
test.before(
  () =>
    new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${server.address().port}/api/chat`;
        resolve();
      });
    })
);
test.after(() => new Promise((resolve) => server.close(resolve)));

test.beforeEach(() => {
  hooks.beforeRoute = null;
  hooks.run = null;
  routeReply = { path: "query", focusVisual: null, confidence: "high", reason: "stub" };
  providerShape = { complete: async () => "text" };
  lastProvider = null;
  calls.length = 0;
});

function frames(text) {
  return text
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter(Boolean)
    .map((b) => JSON.parse(b));
}

async function post(body, init = {}) {
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
  return { res, events: frames(await res.text()) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a client disconnect makes aborted() true and stops the pipeline", async () => {
  let started;
  const reachedPipeline = new Promise((resolve) => {
    started = resolve;
  });
  let sawAbort = null;

  hooks.run = async (name, ctx, emit) => {
    emit({ stage: "working" });
    started();
    // Stands in for the poll each pipeline does before every provider and
    // Power BI call. Bounded so a regression fails rather than hangs.
    for (let i = 0; i < 200 && !ctx.aborted(); i += 1) await wait(10);
    sawAbort = ctx.aborted();
    throw new Error("cancelled");
  };

  const controller = new AbortController();
  const res = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reportId: "r1", question: "q" }),
    signal: controller.signal,
  });
  // Drain, or the body stays buffered and the abort races the first write.
  const reader = res.body.getReader();
  // The abort below rejects this read; swallowing it keeps the rejection from
  // surfacing as the test's own failure.
  reader.read().catch(() => {});

  await reachedPipeline;
  controller.abort();
  reader.cancel().catch(() => {});

  const deadline = Date.now() + 3000;
  while (sawAbort === null && Date.now() < deadline) await wait(10);

  assert.equal(sawAbort, true, "the pipeline's ctx.aborted() must become true on disconnect");
});

test("aborted() stays false for a request the client never abandons", async () => {
  let seen = null;
  hooks.run = async (name, ctx, emit) => {
    // The request body is fully read long before here; only a real disconnect
    // should trip the flag.
    await wait(30);
    seen = ctx.aborted();
    emit({ delta: "ok" });
    return { answer: "ok" };
  };

  const { events } = await post({ reportId: "r1", question: "q" });
  assert.equal(seen, false, "a consumed request body must not look like a disconnect");
  assert.deepEqual(events.at(-1), { done: true, answer: "ok", route: "query" });
});

test("each route.path dispatches to exactly its own pipeline, and done carries the route", async () => {
  for (const name of ["screen", "query", "authoring"]) {
    calls.length = 0;
    routeReply = { path: name, focusVisual: "visual-7", confidence: "high", reason: "stub" };

    const { res, events } = await post({
      reportId: "r1",
      question: "q",
      state: { pageName: "P", visuals: [{ name: "visual-7", title: "Total Sales by Genre", type: "bar" }] },
    });

    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.deepEqual(
      calls.map((c) => c.name),
      [name],
      `${name} must be the only pipeline called`
    );
    assert.equal(calls[0].ctx.focusVisual, "visual-7");
    assert.deepEqual(events[0], { stage: "routing" });
    assert.deepEqual(events.at(-1), { done: true, answer: name, route: name });
  }
});

test("a provider without completeStream is shimmed, and one with it is left alone", async () => {
  await post({ reportId: "r1", question: "q" });
  assert.equal(typeof lastProvider.completeStream, "function");
  let delta = null;
  assert.equal(await lastProvider.completeStream({}, (d) => { delta = d; }), "text");
  assert.equal(delta, "text", "the shim emits the finished text as a single delta");

  const native = { complete: async () => "a", completeStream: async () => "native" };
  providerShape = native;
  await post({ reportId: "r1", question: "q" });
  assert.strictEqual(lastProvider, native, "a native streamer is passed through untouched");
});

test("a thrown pipeline error becomes exactly one mapped error frame", async () => {
  hooks.run = async () => {
    const err = new Error("Power BI: 400 Query (1, 8) The syntax for ')' is incorrect.");
    err.dax = "EVALUATE ROW(\"x\", 1)";
    throw err;
  };

  const { events } = await post({ reportId: "r1", question: "q" });
  const errors = events.filter((e) => e.error);
  assert.equal(errors.length, 1, "exactly one error frame");
  assert.equal(errors[0].error.message, "Couldn't write a query that runs against this dataset.");
  assert.equal(errors[0].error.dax, "EVALUATE ROW(\"x\", 1)");
  assert.match(errors[0].error.details, /400/);
  assert.ok(!events.some((e) => e.done), "no done frame alongside the failure");
});
