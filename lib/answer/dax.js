// lib/answer/dax.js
//
// Shared by the screen pipeline and the data path, so it belongs to neither.

const { problemContext, schemaContext, stripCodeFence, findClarify, splitFormatHint } = require("../chatHelpers");
const { lintDax } = require("../daxLint");
const BUDGETS = require("../budgets");

function buildDaxSystemPrompt(report, opts = {}) {
  const schemaDescription = schemaContext(report);
  return (
    problemContext(report) +
    `You are a DAX query generator for a Power BI dataset. Given a question, ` +
    `return ONLY a single valid DAX query (an EVALUATE statement) that ` +
    `answers it. No prose, no markdown fences, no explanation.\n\n` +
    `Rules — these prevent the most common failures:\n` +
    `- ALWAYS wrap table names in single quotes: 'DataTable'[Column], not ` +
    `DataTable[Column]. This is required even when the name has no spaces.\n` +
    `- A boolean filter argument to CALCULATE/CALCULATETABLE must be a simple ` +
    `comparison on ONE column, e.g. 'T'[Col] = "X". An expression such as ` +
    `YEAR('T'[Date]) = 2023 is INVALID there — wrap it in FILTER instead: ` +
    `FILTER('T', YEAR('T'[Date]) = 2023).\n` +
    `- If the model has a date/calendar dimension table, filter time using ` +
    `its columns (e.g. 'Date'[Year] = 2023) rather than applying YEAR() to a ` +
    `fact-table date column.\n` +
    `- Use only tables, columns and measures named in the schema below. Never ` +
    `invent names, and match their spelling and capitalisation exactly, ` +
    `including any numeric or underscore prefixes on measures.\n` +
    `- Filter values must match the data exactly. If the schema lists the ` +
    `allowed values for a column, use one of those literally.\n` +
    `- When the question implies a breakdown, a ranking, or a comparison ` +
    `across categories, return one row per category via SUMMARIZECOLUMNS ` +
    `grouped by the relevant column(s) — never raw, row-level detail. Only ` +
    `skip grouping when the question genuinely asks for individual records.\n` +
    `- Prefer existing measures over re-aggregating raw columns.\n\n` +
    `After the query, when — and only when — the result it returns is a ` +
    `percentage or ratio, add one more line:\n` +
    `FORMAT: {"percent": true, "decimals": <n>, "scale": "fraction"|"already-percent"}\n` +
    `"decimals" is how many decimal places actually suit the number (0 for a ` +
    `whole-number rate like 42%, 1 or 2 for something more precise). "scale" ` +
    `is "fraction" when the raw value returned is between 0 and 1 (0.42 for ` +
    `42%, the normal Power BI convention for a percentage-formatted measure) ` +
    `and "already-percent" when the value returned is already the percent ` +
    `number itself (42, not 0.42). Omit this line entirely for anything that ` +
    `is not a percentage — do not add a "percent": false line to hedge.\n\n` +
    // Escalation from the visual path already knows exactly what it needs, so
    // a clarifying question there would stall a request the user never sees.
    (opts.allowClarify === false
      ? `The request below already states precisely what is needed. Always ` +
        `return a query — never ask a clarifying question.\n\n`
      : `Ask before guessing. If the question doesn't identify which measure, ` +
        `column, filter or time period it means, and picking wrongly would give ` +
        `a materially different answer, do NOT write a query. Instead reply with ` +
        `a single line of exactly this shape:\n` +
        `CLARIFY: {"questions":[{"ask":"<short question>","multi":false,"options":["<option>","<option>"]}]}\n` +
        `A comparison is the usual case: "compare these" leaves open what to ` +
        `compare against, on which measure, and over which period. Ask each ` +
        `open axis as its own question so they can all be answered at once — ` +
        `at most 3 questions, each with 2 to 6 options.\n` +
        `Set "multi":true where several answers genuinely make sense together ` +
        `(which measures to include, which regions to cover) and false where ` +
        `only one can apply (which axis, which single period). The user ticks ` +
        `them, so this decides whether they may tick more than one.\n` +
        `Example: CLARIFY: {"questions":[{"ask":"Compare against what?","multi":false,"options":["The previous year","Other regions","Other genres"]},{"ask":"Which measures should it show?","multi":true,"options":["Total sales","Number of transactions","Year-on-year change"]}]}\n` +
        `Draw the options from what actually exists in the schema, and word ` +
        `them in plain business language — never expose raw measure or column ` +
        `syntax like [1_ Total Interactions] or 'Table'[Column].\n` +
        `Do not ask when a sensible reading is obvious: a question naming one ` +
        `measure, or one that clearly means the whole dataset, should just be ` +
        `answered. Earlier turns in the conversation count as context — if they ` +
        `already establish the measure or period, use it rather than asking ` +
        `again.\n` +
        `Never ask twice. If the question already carries the specifics — ` +
        `typically after an em dash, e.g. "compare the categories — year over ` +
        `year, by ticket volume" — those ARE the answers to a question you ` +
        `already asked. Write the query.\n\n`) +
    `Dataset schema:\n${schemaDescription}`
  );
}

// Shared by the data path and by escalation from the visual path, so both get
// the same rules, schema grounding and CORE_RULES.
//
// Resolves to { dax, format }. `format` is the optional percentage hint from
// a trailing FORMAT: line -- see splitFormatHint -- or null when the result
// isn't a percentage, or the reply was a clarifying question rather than a
// query at all.
async function generateDaxFor(report, provider, messages, opts = {}) {
  const raw = stripCodeFence(
    await provider.complete({
      system: buildDaxSystemPrompt(report, opts),
      messages,
      // Reasoning models spend completion tokens thinking before emitting
      // anything; this is a ceiling, not a target.
      maxTokens: BUDGETS.MAX_TOKENS_ANALYSIS,
      // Off by default. Turned on only where the query has to line up with
      // something — the entities on screen, a period named in the question —
      // and a plausible-looking wrong query would read as an answer.
      reasoning: opts.reasoning,
    })
  );

  // A clarifying question isn't a query, so it must not be rewritten -- and
  // it never carries a FORMAT line, since the model hasn't chosen a measure
  // yet at that point.
  if (findClarify(raw)) return { dax: raw, format: null };

  const { dax: withoutFormat, format } = splitFormatHint(raw);

  // Repair the SUMMARIZECOLUMNS shapes the model keeps getting wrong even when
  // shown the engine's own error. Each has one correct rewrite, so fixing them
  // here saves a failed round trip to Power BI — see lib/daxLint.js.
  const { dax, notes } = lintDax(withoutFormat);
  if (notes.length) console.error("[dax lint]", notes.join("; "));
  return { dax, format };
}

module.exports = { buildDaxSystemPrompt, generateDaxFor };
