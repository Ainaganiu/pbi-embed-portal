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

// --- the model router ------------------------------------------------------

const BUDGETS = require("./budgets");
const { stripCodeFence } = require("./chatHelpers");

const PATHS = new Set(["screen", "query", "authoring"]);
const MAX_OUTLINE_CHARS = 3000;
const MAX_TITLES = 40;

const ROUTER_SYSTEM =
  `You decide how a question about a Power BI report should be answered. ` +
  `You do not answer it.\n\n` +
  `Reply with ONLY a JSON object:\n` +
  `{"path":"screen"|"query"|"authoring","focusVisual":"<visual id>"|null,` +
  `"confidence":"high"|"low","reason":"<under ten words>"}\n\n` +
  `The paths:\n` +
  `- "screen" — the answer is in what the user currently has on the page. ` +
  `Anything about what is displayed, what it means, what stands out, or ` +
  `about a named visual. Also anything vague enough that reading the page is ` +
  `the honest first move.\n` +
  `- "query" — the answer needs figures the page does not show: another ` +
  `period, a different slice, a total that is not displayed. A fresh query ` +
  `will be written against the dataset.\n` +
  `- "authoring" — the user wants to BUILD or FIX something in Power BI: a ` +
  `measure, a calculated column, a relationship, a broken formula. They want ` +
  `code, not a number.\n\n` +
  `"focusVisual" is the id of the one visual the question is about, when it ` +
  `clearly points at one. Use the id, not the title. Otherwise null.\n\n` +
  `Set "confidence":"low" when the question could sensibly be read more than ` +
  `one way. Low confidence is routed to "screen", because describing the ` +
  `wrong thing is cheaper to recover from than quoting a confidently wrong ` +
  `number — so do not use "low" to hedge a question you can actually place.\n\n` +
  `Earlier turns count: a bare follow-up like "and 2023?" inherits the ` +
  `previous question's path.`;

function routerMessages({ question, history, pageName, visualTitles, filterSummary, schemaOutline }) {
  const titles = (visualTitles || [])
    .slice(0, MAX_TITLES)
    .map((v) => `- ${v.name}: "${v.title}" (${v.type})`)
    .join("\n");

  return [
    ...(history || []),
    {
      role: "user",
      content:
        `Page they are on: ${pageName || "(unknown)"}\n` +
        `Filters currently applied: ${filterSummary || "none"}\n` +
        `Visuals on the page:\n${titles || "(none readable)"}\n\n` +
        `The dataset behind it contains:\n` +
        `${String(schemaOutline || "(not described)").slice(0, MAX_OUTLINE_CHARS)}\n\n` +
        `Question: ${question}`,
    },
  ];
}

/**
 * Picks the answer path. Never throws: every failure returns fallbackRoute,
 * so a router outage degrades to the regexes rather than to an error.
 */
async function chooseRoute(provider, context) {
  const { question, visualTitles = [], hasDataset = true } = context;
  const fallback = () => fallbackRoute({ question, visualTitles, hasDataset });

  // "query" and "authoring" both need a dataset and a schema description, so
  // with neither there is only one possible answer and no call worth paying
  // for.
  if (!hasDataset || !provider) return fallback();

  let parsed;
  try {
    const raw = await provider.complete({
      system: ROUTER_SYSTEM,
      messages: routerMessages(context),
      json: true,
      maxTokens: BUDGETS.MAX_TOKENS_ROUTER,
    });
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    console.error("[route] router call failed, falling back:", err.message);
    return fallback();
  }

  if (!parsed || !PATHS.has(parsed.path)) {
    console.error("[route] router returned an unusable path, falling back:", JSON.stringify(parsed));
    return fallback();
  }

  // A hallucinated visual id would make the screen path focus on nothing.
  const focusVisual =
    parsed.focusVisual && (visualTitles || []).some((v) => v.name === parsed.focusVisual)
      ? parsed.focusVisual
      : null;

  const confidence = parsed.confidence === "high" ? "high" : "low";
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : "";

  // Low confidence goes to the screen, whatever it picked.
  if (confidence === "low" && parsed.path !== "screen") {
    return { path: "screen", focusVisual, confidence, reason: reason || "unsure — reading the page" };
  }

  return { path: parsed.path, focusVisual, confidence, reason };
}

module.exports = { chooseRoute, fallbackRoute, matchVisual };
