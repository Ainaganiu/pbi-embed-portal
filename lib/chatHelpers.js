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

module.exports = { problemContext, sanitizeHistory, stripCodeFence };
