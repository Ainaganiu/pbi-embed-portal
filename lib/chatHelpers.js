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

function stripCodeFence(text) {
  return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
}

module.exports = { problemContext, sanitizeHistory, stripCodeFence };
