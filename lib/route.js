// Which of the three answer paths a question belongs to.
//
// This used to be three regexes in the browser, with a fallback of "six words
// or fewer means look at the screen". They are still here -- but only as the
// fallback for when the model router below can't be reached. A router outage
// should degrade to yesterday's behaviour, not to nothing.

// An explicit reference to what's on screen is decisive: the user is telling
// us they mean the current view even if they also use a data word like
// "trend".
const SCREEN_REFERENCE = /\b(this|these|current|currently|on screen|on-screen|this page|the page|the dashboard|the report|the view|here)\b/i;
const OPEN_ENDED = /\b(summar|overview|walk me through|what am i looking at|explain|interpret|insight|stand out|standing out|notable|going on|tell me about)/i;
const SPECIFIC_QUESTION = /\b(how many|how much|total|count|sum|average|top \d+|bottom \d+|compare|by (year|month|quarter|region|category|channel|publisher|genre))\b/i;

// Building or fixing something in Power BI, rather than asking about the data.
// Checked first: "how do I write a measure for total sales by game" names a
// visual and mentions a measure, but it is an authoring request.
const AUTHORING = /\b(how (do|would) i|how to)\b.*\b(write|create|build|add|make|calculate|fix|debug)\b|\b(dax|measure|calculated column|calculated table|star schema|relationship|power query|m code|time intelligence)\b|\b(why (is|does|isn.t)|what.s wrong with)\b.*\b(measure|dax|formula|calculation)\b/i;

const TITLE_STOPWORDS = new Set(["by", "of", "the", "and", "per", "a", "an", "in", "for", "vs"]);

function titleWords(title) {
  return String(title)
    .toLowerCase()
    .split(/[^a-z0-9%]+/)
    .filter((w) => w && !TITLE_STOPWORDS.has(w));
}

// Which on-screen visual, if any, the question is about. Requires most of the
// title's distinctive words to be present, so "total sales by game" matches
// "Total Sales by Game" while "sales trend since 2019" does not.
function matchVisual(question, visualTitles) {
  const q = String(question || "").toLowerCase();
  let best = null;

  for (const v of visualTitles || []) {
    const words = titleWords(v.title);
    // A single-word title is too weak a signal on its own -- "Region" would
    // match almost any question mentioning regions.
    if (words.length < 2) continue;
    const hits = words.filter((w) => q.includes(w)).length;
    const score = hits / words.length;
    if (score >= 0.7 && (!best || score > best.score || words.length > best.words)) {
      best = { name: v.name, score, words: words.length };
    }
  }
  return best ? best.name : null;
}

function fallbackRoute({ question, visualTitles = [], hasDataset = true }) {
  const q = String(question || "");
  const focusVisual = matchVisual(q, visualTitles);
  const screen = (reason) => ({ path: "screen", focusVisual, confidence: "low", reason });

  // Both other paths need a dataset id and a schema description to run at all.
  if (!hasDataset) return screen("fallback: no dataset configured for this report");

  if (AUTHORING.test(q)) {
    return { path: "authoring", focusVisual: null, confidence: "low", reason: "fallback: authoring keywords" };
  }
  if (SCREEN_REFERENCE.test(q)) return screen("fallback: refers to the current view");
  if (focusVisual) return screen("fallback: names a visual on the page");

  const query = (reason) => ({ path: "query", focusVisual: null, confidence: "low", reason });

  if (OPEN_ENDED.test(q)) {
    return SPECIFIC_QUESTION.test(q)
      ? query("fallback: open-ended but measurable")
      : screen("fallback: open-ended");
  }
  if (SPECIFIC_QUESTION.test(q)) return query("fallback: measurable");

  // Genuinely ambiguous short asks prefer the screen: describing the wrong
  // thing is cheaper to recover from than quoting a confidently wrong number.
  return q.trim().split(/\s+/).length <= 6
    ? screen("fallback: short and ambiguous")
    : query("fallback: no signal");
}

module.exports = { fallbackRoute, matchVisual };
