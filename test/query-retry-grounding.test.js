// test/query-retry-grounding.test.js
//
// A Power BI rejection retry can "succeed" by dropping the very filter that
// caused the rejection, rather than repairing it -- a syntactically valid
// query that silently answers a different question than the one asked.
// Reproduces a real failure: asked for 2023 only, the first (malformed)
// query still named 2023, Power BI rejected it, and the naive syntax-fix
// retry dropped the year filter entirely rather than repairing it.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function stub(rel, exports) {
  const full = require.resolve(path.join(ROOT, rel));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

const BAD_DAX_WITH_YEAR =
  `EVALUATE SUMMARIZECOLUMNS('DataTable'[Category], "Avg", [_ Avg]) FILTER('Date'[Year] = 2023)`;
const RETRY_DAX_MISSING_YEAR =
  `EVALUATE SUMMARIZECOLUMNS('DataTable'[Category], "Avg", [_ Avg]) ORDER BY [Avg] DESC`;
const CORRECTED_DAX_WITH_YEAR =
  `EVALUATE CALCULATETABLE(SUMMARIZECOLUMNS('DataTable'[Category], "Avg", [_ Avg]), 'Date'[Year] = 2023)`;

stub("lib/powerbi", {
  executeQuery: async (_credentials, { dax }) => {
    if (dax === BAD_DAX_WITH_YEAR) throw new Error("The syntax for 'FILTER' is incorrect.");
    return [{ "DataTable[Category]": "Mobile App Issue", Avg: 3.2 }];
  },
});

const query = require(path.join(ROOT, "lib/answer/query.js"));
const llmCache = require(path.join(ROOT, "lib/llmCache.js"));

test.beforeEach(() => llmCache.clear());

function ctx(provider) {
  return {
    report: { id: "r-retry-grounding", workspaceId: "w", datasetId: "d", schemaDescription: "s" },
    settings: {},
    provider,
    question: "Average resolution time per category; 2023 only",
    history: [],
    aborted: () => false,
  };
}

test("a Power BI rejection retry that drops the question's year filter is caught and re-corrected", async () => {
  let daxCallCount = 0;
  const provider = {
    complete: async (request) => {
      if (request.json) {
        return JSON.stringify({ answer: "done", intent: null, followUps: [] });
      }
      daxCallCount += 1;
      if (daxCallCount === 1) return BAD_DAX_WITH_YEAR;
      if (daxCallCount === 2) return RETRY_DAX_MISSING_YEAR;
      return CORRECTED_DAX_WITH_YEAR;
    },
  };

  const result = await query.run(ctx(provider), () => {});

  assert.ok(
    result.dax.includes("2023"),
    "the final query must still filter by the year the question named, not silently drop it"
  );
  assert.equal(daxCallCount, 3, "the retry's dropped filter must trigger one more correction pass");
});

test("every DAX-generation call in the query path requests reasoning, matching the screen path", async () => {
  const seenReasoning = [];
  const provider = {
    complete: async (request) => {
      if (request.json) return JSON.stringify({ answer: "done", intent: null, followUps: [] });
      seenReasoning.push(request.reasoning);
      return CORRECTED_DAX_WITH_YEAR;
    },
  };

  await query.run(ctx(provider), () => {});

  assert.ok(seenReasoning.length >= 1, "at least one DAX call must have happened");
  assert.ok(
    seenReasoning.every((r) => r === "low"),
    `every DAX call must request reasoning, got: ${JSON.stringify(seenReasoning)}`
  );
});
