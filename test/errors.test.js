const test = require("node:test");
const assert = require("node:assert");

const { describe: describeError } = require("../lib/errors");

test("an expired Power BI token tells the user to reload", () => {
  const got = describeError(new Error("Power BI: 401 Unauthorized"));
  assert.match(got.message, /connection to Power BI/i);
  assert.match(got.hint, /reload/i);
  assert.equal(got.retryable, false);
});

test("a missing dataset points at the admin config", () => {
  const got = describeError(new Error("Power BI: 404 DatasetNotFound"));
  assert.match(got.message, /can't reach this report's data/i);
  assert.match(got.hint, /admin/i);
});

test("a DAX failure names the data description and carries the query", () => {
  const got = describeError(new Error("Power BI: 400 Query (1, 8) The syntax for ')' is incorrect."), {
    dax: "EVALUATE TOPN(5, 'Data')",
  });
  assert.match(got.message, /couldn't write a query that runs/i);
  assert.match(got.hint, /data description/i);
  assert.equal(got.dax, "EVALUATE TOPN(5, 'Data')");
});

test("a rate limit is retryable", () => {
  const got = describeError(new Error("openai: 429 Too Many Requests"));
  assert.match(got.message, /busy/i);
  assert.equal(got.retryable, true);
});

test("a rejected API key points at the admin config and is not retryable", () => {
  const got = describeError(new Error("anthropic: 401 invalid x-api-key"));
  assert.match(got.message, /rejected the key/i);
  assert.match(got.hint, /admin/i);
  assert.equal(got.retryable, false);
});

test("an unmapped failure still returns a usable shape and keeps the raw text", () => {
  const got = describeError(new Error("ECONNRESET"));
  assert.match(got.message, /something went wrong/i);
  assert.equal(got.details, "ECONNRESET");
  assert.equal(got.hint, null);
});

test("a non-Error input does not throw", () => {
  const got = describeError(undefined);
  assert.equal(typeof got.message, "string");
  assert.equal(got.details, "");
});
