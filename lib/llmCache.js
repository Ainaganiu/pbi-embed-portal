// Exact-match cache for full /api/chat responses, keyed by report + question
// + conversation context. Repeat questions (a common case -- several viewers
// asking the same thing, or a user re-asking after navigating away) skip the
// LLM + Power BI query entirely, saving both tokens and a query round-trip.
//
// The key used to be (report, question) alone, with caching disabled outright
// whenever there was conversation history: the same three words ("and 2022?")
// can mean something completely different depending on what was asked before
// it, so a cache keyed on the question text alone would return the wrong
// answer to a different conversation that happened to phrase it the same way.
// Folding the prior turns into the key removes that risk without giving up
// caching altogether -- a genuine repeat of the same conversation still hits,
// an unrelated one asking the same words still misses.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 200;

const store = new Map(); // key -> { value, expiresAt }

// A plain, unhashed fingerprint: it never has to be short, only stable and
// exact -- two conversations are "the same" for caching purposes only when
// every turn matches verbatim. JSON.stringify rather than hand-joining, so
// there is no delimiter for a turn's own content to collide with.
function fingerprintOf(priorTurns) {
  const turns = Array.isArray(priorTurns) ? priorTurns : [];
  if (!turns.length) return "";
  return JSON.stringify(turns.map((t) => [t.role, t.content]));
}

function normalizeKey(reportId, question, priorTurns) {
  const q = question.trim().toLowerCase().replace(/\s+/g, " ");
  return `${reportId}::${fingerprintOf(priorTurns)}::${q}`;
}

function get(reportId, question, priorTurns) {
  const key = normalizeKey(reportId, question, priorTurns);
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

function set(reportId, question, value, priorTurns, ttlMs = DEFAULT_TTL_MS) {
  const key = normalizeKey(reportId, question, priorTurns);
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
