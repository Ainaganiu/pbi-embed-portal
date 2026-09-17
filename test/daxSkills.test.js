// test/daxSkills.test.js
//
// These are prompts, not logic, so there is little worth asserting about
// their wording -- a test pinning phrasing would just break every time the
// wording improved. What is worth guarding is the split the module is built
// around: CORE_RULES is prefilled on EVERY DAX generation call, PATTERNS only
// on the authoring path. Nothing stops someone folding the pattern library
// into the hot path, and the cost of that would show up as every question
// getting slower rather than as a failing test.

const test = require("node:test");
const assert = require("node:assert");

const { CORE_RULES, PATTERNS } = require("../lib/daxSkills");

// Room for a rule or two more, and far below what folding PATTERNS (or
// anything that size) into the hot path would cost. A budget sitting a
// hair above today's length is a tripwire rather than a guard: the next
// person to add a line just raises the number, and everyone learns the
// limit is decorative.
const CORE_BUDGET = 3500;

test("both rule sets are non-empty strings", () => {
  assert.equal(typeof CORE_RULES, "string");
  assert.equal(typeof PATTERNS, "string");
  assert.ok(CORE_RULES.length > 0);
  assert.ok(PATTERNS.length > 0);
});

test("CORE_RULES stays small enough to prefill on every question", () => {
  assert.ok(
    CORE_RULES.length <= CORE_BUDGET,
    `CORE_RULES is ${CORE_RULES.length} chars, over the ${CORE_BUDGET} budget — ` +
      `it is paid on every DAX call, so anything that is only useful when ` +
      `authoring belongs in PATTERNS`
  );
});

test("the authoring library is not quietly duplicated into the hot path", () => {
  assert.ok(
    !CORE_RULES.includes(PATTERNS),
    "PATTERNS is authoring-only; prefilling it would slow every question"
  );
});
