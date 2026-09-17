// test/starters.test.js
const test = require("node:test");
const assert = require("node:assert");

const { startersFor, FALLBACK_STARTERS, clearStarterCache } = require("../lib/starters");

const report = { id: "r1", schemaDescription: "Data[Genre], Data[Units], [Total Sales]", problemStatement: "Track sales by genre." };
const fakeProvider = (reply) => ({
  calls: 0,
  async complete() {
    this.calls += 1;
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

test("four starters come back from a valid reply", async () => {
  clearStarterCache();
  const got = await startersFor(fakeProvider(JSON.stringify({ starters: ["A?", "B?", "C?", "D?"] })), report);
  assert.deepEqual(got, ["A?", "B?", "C?", "D?"]);
});

test("more than four are trimmed, fewer are topped up from the fallback", async () => {
  clearStarterCache();
  const got = await startersFor(fakeProvider(JSON.stringify({ starters: ["A?", "B?"] })), report);
  assert.equal(got.length, 4);
  assert.equal(got[0], "A?");
});

test("a failed call returns the hardcoded four rather than nothing", async () => {
  clearStarterCache();
  const got = await startersFor(fakeProvider(new Error("openai: 429")), report);
  assert.deepEqual(got, FALLBACK_STARTERS);
});

test("the second request for a report does not call the provider again", async () => {
  clearStarterCache();
  const provider = fakeProvider(JSON.stringify({ starters: ["A?", "B?", "C?", "D?"] }));
  await startersFor(provider, report);
  await startersFor(provider, report);
  assert.equal(provider.calls, 1);
});

test("a failure is not cached, so the next open can still succeed", async () => {
  clearStarterCache();
  await startersFor(fakeProvider(new Error("openai: 429")), report);
  const got = await startersFor(fakeProvider(JSON.stringify({ starters: ["A?", "B?", "C?", "D?"] })), report);
  assert.equal(got[0], "A?");
});
