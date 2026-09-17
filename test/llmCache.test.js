// test/llmCache.test.js
//
// The cache used to be keyed on (report, question) alone, with history
// disabled entirely as the guard against a false hit -- "and 2022?" in one
// conversation could otherwise return a cached answer meant for a different
// conversation that happened to ask the same three words. Folding the prior
// turns into the key lets a genuine repeat of the same conversation hit
// cache, while an unrelated one asking the same words still misses.

const test = require("node:test");
const assert = require("node:assert");

const llmCache = require("../lib/llmCache");

test.beforeEach(() => llmCache.clear());

test("a standalone question behaves exactly as before: set then get hits", () => {
  llmCache.set("r1", "sales by genre", { answer: "A" }, []);
  assert.deepEqual(llmCache.get("r1", "sales by genre", []), { answer: "A" });
});

test("the same question with the same prior turns hits", () => {
  const history = [
    { role: "user", content: "sales by genre in 2021" },
    { role: "assistant", content: "Action led." },
  ];
  llmCache.set("r1", "and 2022?", { answer: "B" }, history);
  assert.deepEqual(llmCache.get("r1", "and 2022?", history), { answer: "B" });
});

test("the same question with DIFFERENT prior turns misses", () => {
  const history1 = [{ role: "user", content: "sales by genre in 2021" }];
  const history2 = [{ role: "user", content: "sales by region in 2021" }];
  llmCache.set("r1", "and 2022?", { answer: "B" }, history1);
  assert.equal(llmCache.get("r1", "and 2022?", history2), null);
});

test("a standalone question never collides with the same words asked mid-conversation", () => {
  llmCache.set("r1", "and 2022?", { answer: "standalone" }, []);
  const history = [{ role: "user", content: "sales by genre in 2021" }];
  assert.equal(llmCache.get("r1", "and 2022?", history), null);
});

test("different reports never share a cache entry, history held equal", () => {
  const history = [{ role: "user", content: "sales by genre in 2021" }];
  llmCache.set("r1", "and 2022?", { answer: "for r1" }, history);
  assert.equal(llmCache.get("r2", "and 2022?", history), null);
});
