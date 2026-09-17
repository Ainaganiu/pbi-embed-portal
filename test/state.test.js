// test/state.test.js
//
// The router is shown up to 40 visuals when it picks the one a question is
// about, but only VISUALS_IN_PROMPT of them reach the prompt. A focus beyond
// that cut used to be sliced away before the focus tag was applied, so the
// answer was composed without the visual the question named -- silently.

const test = require("node:test");
const assert = require("node:assert");

const BUDGETS = require("../lib/budgets");
const { renderReportState } = require("../lib/answer/state");

const FOCUS_TAG = "THE VISUAL THE QUESTION IS ABOUT";

function page(count) {
  return {
    pageName: "Overview",
    visuals: Array.from({ length: count }, (_, i) => ({
      name: `v${i + 1}`,
      title: `Visual ${i + 1}`,
      type: "barChart",
      data: `Genre,Sales\n${"x".repeat(BUDGETS.CHARS_FOCUSED_VISUAL)}`,
    })),
  };
}

test("a focus visual beyond the prompt budget is still rendered, with its tag", () => {
  const beyond = BUDGETS.VISUALS_IN_PROMPT + 5;
  const text = renderReportState(page(beyond + 3), `v${beyond}`);

  assert.ok(text.includes(`"Visual ${beyond}"`), "the focused visual made it into the prompt");
  assert.ok(text.includes(FOCUS_TAG), "and it is marked as the one being asked about");
});

test("the focused visual gets the larger character budget", () => {
  const beyond = BUDGETS.VISUALS_IN_PROMPT + 5;
  const state = page(beyond + 3);
  // One visual's worth of data, so the slice length is unambiguous.
  const text = renderReportState(state, `v${beyond}`);
  const focusBlock = text.split(`"Visual ${beyond}"`)[1].split('\n\n')[0];

  assert.ok(
    focusBlock.length > BUDGETS.CHARS_PER_VISUAL,
    "the focus is not capped at the ordinary per-visual budget"
  );
});

test("the omitted count matches what was actually left out", () => {
  const total = BUDGETS.VISUALS_IN_PROMPT + 10;
  const text = renderReportState(page(total), `v${total}`);
  assert.ok(
    text.includes(`(${total - BUDGETS.VISUALS_IN_PROMPT} further visuals omitted.)`),
    "hoisting the focus in does not change how many are omitted"
  );
});

test("without a focus the visuals keep their page order", () => {
  const text = renderReportState(page(3), null);
  assert.ok(text.indexOf('"Visual 1"') < text.indexOf('"Visual 2"'));
  assert.ok(!text.includes(FOCUS_TAG));
});

test("a focus inside the budget is untouched", () => {
  const text = renderReportState(page(BUDGETS.VISUALS_IN_PROMPT), "v2");
  assert.ok(text.indexOf('"Visual 1"') < text.indexOf('"Visual 2"'), "no needless reordering");
  assert.ok(text.includes(FOCUS_TAG));
});
