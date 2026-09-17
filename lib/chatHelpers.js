// Small helpers shared by the chat routes.

// Business context the admin wrote for a report. Cached in memory with the
// rest of the report config, and prepended to every prompt so answers stay
// anchored to what the dashboard is actually for.
function problemContext(report) {
  if (!report.problemStatement) return "";
  return `Business context for this dashboard — keep this in mind throughout:\n${report.problemStatement}\n\n`;
}

// Prior turns arrive from the browser, so treat them as untrusted input:
// keep only the expected shape, cap the count, and cap each message.
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 1500;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));
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

// The marker is specified as the first line, and models mostly comply — but
// not always. Left to "first line only" detection, a reply that opens with a
// sentence of apology and *then* asks properly gets shown to the user as raw
// JSON, which is the worst of both worlds. So find the marker wherever it
// lands, and treat whatever came before it as the lead-in.
const CLARIFY_AT = /(^|\n)[ \t]*CLARIFY[ \t]*:/i;

function findClarify(text) {
  const raw = String(text || "");
  const match = raw.match(CLARIFY_AT);
  if (!match) return null;
  const at = match.index + match[1].length;
  return { lead: raw.slice(0, match.index).trim(), payload: raw.slice(at) };
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

const MAX_FOLLOW_UPS = 3;
const FOLLOW_UP_LINE = /\n*[ \t]*FOLLOW[_ ]?UPS?[ \t]*:([^\n]*)\s*$/i;

// Every marker the model can emit. None of them is meant for human eyes, so
// none may reach the bubble — not the one at the head, and not one that turns
// up halfway through a reply that started as prose.
const MARKER_WORDS = ["FOLLOW_UPS:", "CLARIFY:", "NEED_DATA:"];
const ANY_MARKER = /FOLLOW[_ ]?UPS?[ \t]*:|CLARIFY[ \t]*:|NEED[_ ]?DATA[ \t]*:/i;

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
  sanitizeHistory,
  stripCodeFence,
  parseClarify,
  findClarify,
  FOLLOW_UP_RULE,
  splitFollowUps,
  emitSafe,
};
