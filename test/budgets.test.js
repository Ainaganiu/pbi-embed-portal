// test/budgets.test.js
const test = require("node:test");
const assert = require("node:assert");

const BUDGETS = require("../lib/budgets");

// Every cap the chat pipeline honours lives here. The test exists so a typo in
// a consumer -- BUDGETS.RESULT_ROW, say -- fails loudly here rather than
// silently becoming `undefined` and uncapping a prompt.
const EXPECTED = {
  CHARS_PER_VISUAL: 1200,
  CHARS_FOCUSED_VISUAL: 6000,
  STATE_CHARS: 40000,
  VISUALS_IN_PROMPT: 25,
  EXPORT_ROWS_PER_VISUAL: 30,
  RESULT_ROWS: 500,
  RESULT_CHARS: 120000,
  HISTORY_EXCHANGES_TO_MODEL: 10,
  HISTORY_MESSAGES_ACCEPTED: 20,
  HISTORY_CHARS_PER_TURN: 4000,
  HISTORY_EXCHANGES_STORED: 40,
  MAX_TOKENS_ANALYSIS: 16000,
  MAX_TOKENS_ROUTER: 400,
  CHART_MAX_CATEGORIES: 18,
  CHART_TRUNCATE_TO: 15,
  MODEL_CARD_CHARS: 20000,
};

test("every budget is present with the agreed value", () => {
  assert.deepEqual(BUDGETS, EXPECTED);
});

test("budgets are frozen, so nothing can raise a cap at runtime", () => {
  assert.throws(() => {
    "use strict";
    BUDGETS.RESULT_ROWS = 999999;
  });
});

test("the focused visual gets more room than a context visual", () => {
  assert.ok(BUDGETS.CHARS_FOCUSED_VISUAL > BUDGETS.CHARS_PER_VISUAL);
});

test("truncating a chart leaves fewer categories than the threshold that triggers it", () => {
  assert.ok(BUDGETS.CHART_TRUNCATE_TO < BUDGETS.CHART_MAX_CATEGORIES);
});
