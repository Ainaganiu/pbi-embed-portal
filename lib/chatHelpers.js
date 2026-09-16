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
const MAX_CLARIFY_OPTIONS = 4;

function parseClarify(text) {
  const raw = String(text).replace(/^\s*CLARIFY:\s*/i, "").trim();

  const asPlain = () => [{ ask: raw.replace(/\s+/g, " "), options: [] }];
  // Never show a malformed payload to the user as though it were a question.
  const asGeneric = () => [
    { ask: "Could you say a bit more about what you'd like to see?", options: [] },
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
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => typeof o === "string" && o.trim())
        .slice(0, MAX_CLARIFY_OPTIONS)
        .map((o) => o.trim()),
    }));

  return cleaned.length ? cleaned : asGeneric();
}

module.exports = { problemContext, sanitizeHistory, stripCodeFence, parseClarify };
