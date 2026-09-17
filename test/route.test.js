const test = require("node:test");
const assert = require("node:assert");

const { fallbackRoute } = require("../lib/route");

const TITLES = [
  { name: "v1", title: "Total Sales by Game", type: "barChart" },
  { name: "v2", title: "Region", type: "slicer" },
];

const route = (question, opts = {}) =>
  fallbackRoute({ question, visualTitles: TITLES, hasDataset: true, ...opts });

test("a DAX how-to is an authoring question", () => {
  assert.equal(route("how do I write a measure for year on year growth").path, "authoring");
});

test("naming DAX at all is enough to be authoring", () => {
  assert.equal(route("my time intelligence calculation returns blank").path, "authoring");
});

test("pointing at the screen routes to the screen", () => {
  assert.equal(route("what is this page telling me").path, "screen");
});

test("naming a visual on the page routes to the screen and focuses it", () => {
  const got = route("what does total sales by game show");
  assert.equal(got.path, "screen");
  assert.equal(got.focusVisual, "v1");
});

test("a single-word title is too weak to focus on", () => {
  const got = route("which region sold most", { visualTitles: TITLES });
  assert.equal(got.focusVisual, null);
});

test("a measurable question goes to the query pipeline", () => {
  assert.equal(route("how many units sold by genre").path, "query");
});

test("an open-ended question that is also specific prefers the query pipeline", () => {
  assert.equal(route("explain how many units sold by region").path, "query");
});

test("a short ambiguous question prefers the screen", () => {
  assert.equal(route("anything odd").path, "screen");
});

test("a long ambiguous question falls to the query pipeline", () => {
  assert.equal(route("give me the numbers behind last quarter performance overall").path, "query");
});

test("without a dataset everything routes to the screen", () => {
  assert.equal(route("how many units sold by genre", { hasDataset: false }).path, "screen");
  assert.equal(route("how do I write a measure", { hasDataset: false }).path, "screen");
});

test("the fallback always reports low confidence", () => {
  assert.equal(route("what is this page telling me").confidence, "low");
});

const { chooseRoute } = require("../lib/route");

// A provider stub: `reply` is what complete() resolves to, or an Error to throw.
const fakeProvider = (reply) => ({
  calls: [],
  async complete(request) {
    this.calls.push(request);
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

const ctx = {
  question: "how many units sold by genre",
  history: [],
  pageName: "Overview",
  visualTitles: TITLES,
  filterSummary: "none",
  schemaOutline: "Data[Genre], Data[Units], [Total Sales]",
  hasDataset: true,
};

test("a valid router reply is used as-is", async () => {
  const provider = fakeProvider(
    JSON.stringify({ path: "query", focusVisual: null, confidence: "high", reason: "asks for a figure" })
  );
  const got = await chooseRoute(provider, ctx);
  assert.equal(got.path, "query");
  assert.equal(got.confidence, "high");
  assert.equal(got.reason, "asks for a figure");
});

test("a fenced reply is still parsed", async () => {
  const provider = fakeProvider('```json\n{"path":"screen","focusVisual":"v1","confidence":"high","reason":"points at a visual"}\n```');
  const got = await chooseRoute(provider, ctx);
  assert.equal(got.path, "screen");
  assert.equal(got.focusVisual, "v1");
});

test("low confidence is routed to the screen whatever the model picked", async () => {
  const provider = fakeProvider(
    JSON.stringify({ path: "query", focusVisual: null, confidence: "low", reason: "not sure" })
  );
  assert.equal((await chooseRoute(provider, ctx)).path, "screen");
});

test("a focusVisual that is not on the page is dropped", async () => {
  const provider = fakeProvider(
    JSON.stringify({ path: "screen", focusVisual: "v99", confidence: "high", reason: "x" })
  );
  assert.equal((await chooseRoute(provider, ctx)).focusVisual, null);
});

test("an unknown path falls back", async () => {
  const provider = fakeProvider(
    JSON.stringify({ path: "telepathy", focusVisual: null, confidence: "high", reason: "x" })
  );
  const got = await chooseRoute(provider, ctx);
  assert.equal(got.path, "query");
  assert.match(got.reason, /^fallback:/);
});

test("malformed JSON falls back", async () => {
  const got = await chooseRoute(fakeProvider("I think this is a query question!"), ctx);
  assert.equal(got.path, "query");
  assert.match(got.reason, /^fallback:/);
});

test("a thrown provider error falls back rather than propagating", async () => {
  const got = await chooseRoute(fakeProvider(new Error("openai: 429")), ctx);
  assert.equal(got.path, "query");
  assert.match(got.reason, /^fallback:/);
});

test("no provider at all falls back", async () => {
  const got = await chooseRoute(null, ctx);
  assert.equal(got.path, "query");
  assert.match(got.reason, /^fallback:/);
});

test("without a dataset the router is not even called", async () => {
  const provider = fakeProvider(JSON.stringify({ path: "query", focusVisual: null, confidence: "high", reason: "x" }));
  const got = await chooseRoute(provider, { ...ctx, hasDataset: false });
  assert.equal(got.path, "screen");
  assert.equal(provider.calls.length, 0, "a call that cannot change the answer is a call not worth paying for");
});

test("the router is given the page, the visual titles and the filters", async () => {
  const provider = fakeProvider(JSON.stringify({ path: "screen", focusVisual: null, confidence: "high", reason: "x" }));
  await chooseRoute(provider, ctx);
  const sent = provider.calls[0].messages.map((m) => m.content).join("\n");
  assert.match(sent, /Overview/);
  assert.match(sent, /Total Sales by Game/);
  assert.match(sent, /how many units sold by genre/);
  assert.equal(provider.calls[0].json, true);
  assert.equal(provider.calls[0].maxTokens, 400);
});
