// Small helpers shared by the chat routes.

// Business context the admin wrote for a report. Cached in memory with the
// rest of the report config, and prepended to every prompt so answers stay
// anchored to what the dashboard is actually for.
function problemContext(report) {
  if (!report.problemStatement) return "";
  return `Business context for this dashboard — keep this in mind throughout:\n${report.problemStatement}\n\n`;
}

// The schema description used to be the only place an admin could describe
// the model at all, so anything about a specific measure or column got
// folded into one undifferentiated blob. Measures and columns get their own
// fields now, so this combines the three into one block with each section
// labelled -- an admin can paste focused metadata for a measure without it
// getting lost in general schema notes, and the model can tell which is
// which rather than parsing it apart itself. A section that was never filled
// in is simply left out, so a report using only the original field behaves
// exactly as it always did.
function schemaContext(report) {
  // One card when the model has been read: structure from the model, meaning
  // from the descriptions, merged. Falls back to the typed text alone
  // whenever it has not been -- or whenever rendering it throws, since stored
  // metadata is arbitrary JSONB and can be malformed in ways normalise() no
  // longer prevents at the source -- so nothing here can take the chat down.
  let card = "";
  try {
    card = renderModelCard(report?.modelMetadata || null, report || {});
  } catch (err) {
    console.error("[model card] render failed, falling back to typed description:", err.message);
  }
  if (card) return card;

  const parts = [];
  if (report.schemaDescription) parts.push(report.schemaDescription);
  if (report.measuresDescription) parts.push(`Measure definitions:\n${report.measuresDescription}`);
  if (report.columnsDescription) parts.push(`Column definitions:\n${report.columnsDescription}`);
  return parts.length ? parts.join("\n\n") : "(not described)";
}

const { render: renderModelCard } = require("./modelCard");
const BUDGETS = require("./budgets");

// Prior turns arrive from the browser, so treat them as untrusted input:
// keep only the expected shape, cap the count, and cap each message.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-BUDGETS.HISTORY_MESSAGES_ACCEPTED)
    .map((m) => ({ role: m.role, content: m.content.slice(0, BUDGETS.HISTORY_CHARS_PER_TURN) }));
}

// Models wrap code in a fence however firmly they're told not to, and the
// fence often arrives with leading whitespace or a language tag ("```DAX"),
// so this can't anchor at position 0 — an unstripped backtick reaches the
// query engine as a syntax error at offset 1.
function stripCodeFence(text) {
  return String(text)
    .replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n?/, "")
    .replace(/```\s*$/, "")
    .trim();
}

// A CLARIFY payload is meant to be JSON, but models drift back to prose often
// enough that the prose form has to keep working — a clarifying question the
// user can read is far better than an error. Returns a normalised shape either
// way: [{ ask, options }].
const MAX_CLARIFY_QUESTIONS = 3;
const MAX_CLARIFY_OPTIONS = 6;

// Markers are specified as the first line, and models mostly comply — but not
// always. Left to "first line only" detection, a reply that explains itself
// first and *then* emits the marker falls through as ordinary prose, so the
// user is shown the raw marker and the action it asked for never happens. So
// find it wherever it lands.
//
// What comes before is kept, not discarded: an analyst saying "the page shows
// five genres and isn't filtered to 2016, so I'll query the model" is giving
// exactly the right framing for what follows.
// Matched anywhere, not just at the start of a line. Across runs of the same
// question this model puts the marker on its own line most times and inline at
// the end of a sentence the rest — and under line-anchored matching those runs
// silently did nothing, which is worse than failing. The markers are
// ALL-CAPS tokens ending in a colon that nobody writes conversationally, so
// matching them loose costs nothing.
function findMarker(text, name) {
  const raw = String(text || "");
  const pattern = new RegExp(`\\b${name}[ \\t]*:`, "i");
  const match = raw.match(pattern);
  if (!match) return null;
  return {
    lead: raw.slice(0, match.index).trim(),
    payload: raw.slice(match.index + match[0].length).replace(/^[ \t]*/, ""),
  };
}

function findClarify(text) {
  return findMarker(text, "CLARIFY");
}

function findNeedData(text) {
  return findMarker(text, "NEED[_ ]?DATA");
}

// "it's not on the page" — a turn that only confirms what the assistant just
// said, adding no new question. Re-running the whole analysis on one of these
// produces the same reply again, which is the loop the user actually hit. If
// the previous turn already worked out what it needed, go and fetch it.
const CONFIRMING = /^(yes|yep|yeah|correct|right|exactly|true|ok(ay)?|sure|do it|go ahead|please do|it'?s not (on|in) the page|not on the page|thats? right|i know|indeed)\b[\s.!,]*$/i;

function confirmsPreviousTurn(question, history) {
  const q = String(question || "").trim();
  if (!q || q.length > 40 || !CONFIRMING.test(q)) return null;

  const prior = Array.isArray(history) ? history : [];
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const turn = prior[i];
    if (turn?.role !== "assistant") continue;
    const needed = findNeedData(turn.content);
    return needed ? needed.payload.trim() : null;
  }
  return null;
}

// Whether a question points at what is on screen ("compare THESE games with
// last year") or asks for a fresh set ("top 10 genres in 2016").
//
// The escalated query is constrained to the entities on screen so that
// "these games in 2015" doesn't come back as 2015's own top five — a different
// question that looks like an answer. But applying that constraint to a
// genuine top-N request is the same mistake in reverse: asked for the top 10
// it returned exactly the five already visible, then explained it couldn't
// find ten. So constrain only when the question actually refers back.
const DEICTIC = /\b(these|those|them|the(se|se ones)?\s+(same|ones)|above|on screen|on the (page|chart|visual)|shown|listed|currently)\b/i;
// A request for a fresh ranking overrides the above: "the top 10 shown" is
// still asking for ten.
const FRESH_RANKING = /\b(top|bottom|first|last)\s*\d+\b|\ball\b/i;

function refersToScreenEntities(question) {
  const q = String(question || "");
  if (FRESH_RANKING.test(q)) return false;
  return DEICTIC.test(q);
}

// A DAX reply optionally carries one more line after the query itself:
// FORMAT: {"percent":true,"decimals":1,"scale":"fraction"} -- appended only
// when the result is naturally a percentage, since there is no live schema
// fetch this app can use to know that on its own. Splitting it out here,
// rather than leaving it appended to the string, is what stops the line
// becoming part of the query text actually sent to Power BI.
//
// findMarker requires a colon right after the word, so a real DAX FORMAT()
// function call -- FORMAT([Value], "0%") -- is never mistaken for this: the
// character after "FORMAT" there is "(", not ":".
function splitFormatHint(text) {
  const found = findMarker(text, "FORMAT");
  if (!found) return { dax: String(text || "").trim(), format: null };

  let format = null;
  try {
    const parsed = JSON.parse(stripCodeFence(found.payload.trim()));
    if (parsed && typeof parsed === "object" && parsed.percent === true) {
      const decimals = Number.isFinite(parsed.decimals) ? Math.trunc(parsed.decimals) : 0;
      format = {
        percent: true,
        decimals: Math.max(0, Math.min(4, decimals)),
        scale: parsed.scale === "already-percent" ? "already-percent" : "fraction",
      };
    }
  } catch {
    // A malformed hint costs nothing but the formatting -- the query itself
    // is still good, and the marker line must still come off it either way.
  }
  return { dax: found.lead, format };
}

// A chart spec the model appends to a streamed prose answer, so the escalation
// path can draw the rows it fetched without a second round trip. Same shape as
// the data path's "chart" field.
function splitChart(text) {
  const found = findMarker(text, "CHART");
  if (!found) return { answer: String(text || "").trim(), chart: null };

  let chart = null;
  try {
    const parsed = JSON.parse(stripCodeFence(found.payload.trim()));
    if (parsed && typeof parsed === "object") chart = parsed;
  } catch {
    // A malformed spec is not worth failing an otherwise good answer over.
  }
  return { answer: found.lead, chart };
}

function parseClarify(text) {
  const raw = String(text).replace(/^\s*CLARIFY:\s*/i, "").trim();

  const asPlain = () => [{ ask: raw.replace(/\s+/g, " "), options: [], multi: false }];
  // Never show a malformed payload to the user as though it were a question.
  const asGeneric = () => [
    { ask: "Could you say a bit more about what you'd like to see?", options: [], multi: false },
  ];
  if (!raw.startsWith("{")) return asPlain();

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch {
    return asGeneric();
  }

  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const cleaned = questions
    .filter((q) => q && typeof q.ask === "string" && q.ask.trim())
    .slice(0, MAX_CLARIFY_QUESTIONS)
    .map((q) => ({
      ask: q.ask.trim(),
      // "Which measures?" can legitimately take several answers; "which axis?"
      // cannot. The model says which kind it is, and the panel renders
      // checkboxes or radios to match, so the control itself tells the user
      // whether more than one answer is allowed.
      multi: q.multi === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => typeof o === "string" && o.trim())
        .slice(0, MAX_CLARIFY_OPTIONS)
        .map((o) => o.trim()),
    }));

  return cleaned.length ? cleaned : asGeneric();
}

// ---- follow-up suggestions ------------------------------------------------
//
// Every answer ends with three questions it naturally leads to, rendered as
// one-click chips. They come from the answering model rather than a second
// call: it has just read the data and knows what it left unsaid, the tokens
// are trivial, and they arrive at the tail of a stream the user is already
// reading — so they cost nothing anyone waits for.

const FOLLOW_UP_RULE =
  `Finally, after a blank line, end with exactly one more line:\n` +
  `FOLLOW_UPS: <question> | <question> | <question>\n` +
  `Three questions this answer naturally leads to, each answerable from this ` +
  `same report, each under nine words, pipe-separated. Prefer questions that ` +
  `go somewhere new — a breakdown, a comparison, a cause — rather than a ` +
  `restatement of what you just said. No numbering, nothing else on that line.\n`;

// The DAX-generation prompt already forbids inventing a table, column or
// measure name — this is the same discipline applied to the prose answer,
// where there is no query engine to reject a name that doesn't exist. A
// fabricated relationship or a guessed measure definition reads exactly as
// confident as a real one, so it has to be ruled out explicitly rather than
// left to follow from the DAX rule alone.
const GROUNDING_RULE =
  // Deliberately says "as described" rather than "above"/"below" -- the
  // schema text sits in a different position in each prompt that uses this.
  `Ground everything you say in the semantic model as it is actually ` +
  `described — its schema, measures and column definitions. Never assume a ` +
  `relationship, a business rule, or what a measure means beyond what is ` +
  `actually stated; say you don't know rather than guess.\n`;

const MAX_FOLLOW_UPS = 3;
const FOLLOW_UP_LINE = /\n*[ \t]*FOLLOW[_ ]?UPS?[ \t]*:([^\n]*)\s*$/i;

// Every marker the model can emit. None of them is meant for human eyes, so
// none may reach the bubble — not the one at the head, and not one that turns
// up halfway through a reply that started as prose.
const MARKER_WORDS = ["FOLLOW_UPS:", "CLARIFY:", "NEED_DATA:", "CHART:"];
const ANY_MARKER = /FOLLOW[_ ]?UPS?[ \t]*:|CLARIFY[ \t]*:|NEED[_ ]?DATA[ \t]*:|CHART[ \t]*:/i;

// Splits a completed answer into the prose and the suggestions.
function splitFollowUps(text) {
  const raw = String(text || "");
  const match = raw.match(FOLLOW_UP_LINE);
  if (!match) return { answer: raw.trim(), followUps: [] };
  const followUps = match[1]
    .split("|")
    .map((s) => s.replace(/^[\s\-*\d.)]+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .slice(0, MAX_FOLLOW_UPS);
  return { answer: raw.slice(0, match.index).trim(), followUps };
}

// How much of a partial stream is safe to forward: everything before the first
// marker, and never a trailing fragment that might turn out to be the start of
// one. Without the second part, "CLARIFY" flashes in the bubble for a chunk or
// two before the final frame replaces it.
function emitSafe(acc) {
  const at = acc.search(ANY_MARKER);
  if (at !== -1) return acc.slice(0, at);

  let cut = acc.length;
  for (const word of MARKER_WORDS) {
    for (let n = Math.min(word.length - 1, acc.length); n > 0; n -= 1) {
      if (acc.slice(acc.length - n).toUpperCase() === word.slice(0, n)) {
        cut = Math.min(cut, acc.length - n);
        break;
      }
    }
  }
  return acc.slice(0, cut);
}

module.exports = {
  problemContext,
  schemaContext,
  sanitizeHistory,
  stripCodeFence,
  parseClarify,
  findClarify,
  findNeedData,
  confirmsPreviousTurn,
  refersToScreenEntities,
  findMarker,
  splitChart,
  splitFormatHint,
  FOLLOW_UP_RULE,
  GROUNDING_RULE,
  splitFollowUps,
  emitSafe,
};
