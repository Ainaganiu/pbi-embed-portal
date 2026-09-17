// Mechanical repairs applied to generated DAX before it reaches Power BI.
//
// These exist because prompting did not hold. The model is told the
// SUMMARIZECOLUMNS contract in CORE_RULES and told again, with the engine's own
// error text, on the retry — and still puts a measure or a VALUES() wrapper in
// a group-by slot, because that is what the function *looks* like it should
// accept. A rule the model keeps breaking is better enforced in code: these
// two shapes have exactly one correct rewrite each, so there is nothing to
// guess and no round trip to spend.
//
// Anything not covered here is left alone and allowed to fail, so the existing
// error-feedback retry still gets its turn.

// Splits an argument list on commas that are at depth zero, respecting nested
// calls and quoted text. A naive split on "," breaks on the first
// CALCULATE(..., ...) or a name containing a comma.
function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let quote = null;
  let start = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      args.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  args.push(inner.slice(start));
  return args;
}

// Finds each SUMMARIZECOLUMNS(...) call and returns its bounds, innermost
// first so rewriting one can't invalidate the offsets of another.
function findCalls(dax, name) {
  const calls = [];
  const re = new RegExp(name + "\\s*\\(", "gi");
  let m;
  while ((m = re.exec(dax)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let quote = null;
    for (let i = open; i < dax.length; i += 1) {
      const c = dax[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) {
          calls.push({ start: m.index, open, close: i });
          break;
        }
      }
    }
  }
  return calls.reverse();
}

const COLUMN_REF = /^'[^']+'\[[^\]]+\]$|^\w+\[[^\]]+\]$/;
const MEASURE_REF = /^\[([^\]]+)\]$/;
const WRAPPED_COLUMN = /^(?:VALUES|DISTINCT)\s*\(\s*('[^']+'\[[^\]]+\]|\w+\[[^\]]+\])\s*\)$/i;

// Rewrites the group-by section of every SUMMARIZECOLUMNS call:
//
//   VALUES('Genre'[Genre])  ->  'Genre'[Genre]
//   [Total Revenue]         ->  moved to the end as "Total Revenue", [Total Revenue]
//
// Both produce "SUMMARIZECOLUMNS() expects a column name as argument number N"
// against a real model, which is the failure this repairs.
function fixSummarizeColumns(dax) {
  let out = String(dax);
  const notes = [];

  for (const call of findCalls(out, "SUMMARIZECOLUMNS")) {
    const inner = out.slice(call.open + 1, call.close);
    const args = splitArgs(inner);
    if (args.length < 2) continue;

    // The group-by section runs until the first string literal, which starts
    // the "Name", expression pairs.
    let firstName = args.findIndex((a) => a.trim().startsWith('"'));
    if (firstName === -1) firstName = args.length;

    const groupBy = [];
    const moved = [];
    let changed = false;

    for (let i = 0; i < firstName; i += 1) {
      const arg = args[i].trim();

      const wrapped = arg.match(WRAPPED_COLUMN);
      if (wrapped) {
        groupBy.push(wrapped[1]);
        notes.push(`unwrapped ${arg} to ${wrapped[1]}`);
        changed = true;
        continue;
      }

      const measure = arg.match(MEASURE_REF);
      if (measure && !COLUMN_REF.test(arg)) {
        // A measure cannot group anything. It was meant to be a returned
        // value, so give it the name/expression form it needs.
        moved.push(`"${measure[1]}", ${arg}`);
        notes.push(`moved measure ${arg} out of the group-by section`);
        changed = true;
        continue;
      }

      groupBy.push(arg);
    }

    if (!changed) continue;

    const rest = args.slice(firstName).map((a) => a.trim());
    const rebuilt = [...groupBy, ...rest, ...moved].filter(Boolean).join(", ");
    out = out.slice(0, call.open + 1) + rebuilt + out.slice(call.close);
  }

  return { dax: out, notes };
}

function lintDax(dax) {
  return fixSummarizeColumns(dax);
}

// ---- grounding -----------------------------------------------------------
//
// The retry loop only fires when Power BI rejects a query. A query that runs
// but answers a different question never trips it, and that is the worse
// failure: asked for "top 10 genres in 2016" the model returned all-time
// totals with a fabricated "YearFilter", 1 column, and the narrative on top
// said "In 2016…". A wrong number presented confidently beats an error every
// time, so these two shapes are checked before the query is ever run.

const YEAR_IN_QUESTION = /\b(19|20)\d{2}\b/g;
// A "Name", <constant> pair: a column of literal 1s or "Yes" is never an
// answer, it is a filter the model meant to apply and didn't.
const CONSTANT_PAIR = /"[^"]*"\s*,\s*(-?\d+(?:\.\d+)?|TRUE\(\)|FALSE\(\))\s*[,)]/i;

function groundingIssues(question, dax) {
  const issues = [];
  const q = String(question || "");
  const d = String(dax || "");

  const years = [...new Set(q.match(YEAR_IN_QUESTION) || [])];
  const missing = years.filter((y) => !d.includes(y));
  if (missing.length) {
    issues.push(
      `the question names ${missing.join(" and ")} but the query does not ` +
        `filter on ${missing.length > 1 ? "those years" : "that year"}`
    );
  }

  if (CONSTANT_PAIR.test(d)) {
    issues.push(
      "the query returns a column whose value is a constant, which filters nothing"
    );
  }

  return issues;
}

module.exports = { lintDax, fixSummarizeColumns, splitArgs, groundingIssues };
