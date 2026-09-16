// Exact-match cache for full /api/chat responses, keyed by report + question.
// Repeat questions (a common case — several viewers asking the same thing,
// or a user re-asking after navigating away) skip the LLM + Power BI query
// entirely, saving both tokens and a query round-trip.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 200;

const store = new Map(); // key -> { value, expiresAt }

function normalizeKey(reportId, question) {
  return `${reportId}::${question.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function get(reportId, question) {
  const key = normalizeKey(reportId, question);
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  // Re-insert to mark as most-recently-used for the eviction order below.
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

function set(reportId, question, value, ttlMs = DEFAULT_TTL_MS) {
  const key = normalizeKey(reportId, question);
  if (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    store.delete(oldestKey);
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clear() {
  store.clear();
}

module.exports = { get, set, clear };
