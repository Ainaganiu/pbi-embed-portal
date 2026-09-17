// lib/starters.js
//
// Four opening questions, written from the report's own schema and problem
// statement.
//
// The hardest part of using a dashboard you didn't build is knowing what to
// ask it. Four generic prompts were better than an empty box, but they were
// the same four for every report in the portal.

const BUDGETS = require("./budgets");
const { stripCodeFence } = require("./chatHelpers");

const FALLBACK_STARTERS = [
  "What is this page telling me?",
  "What stands out on this page?",
  "Any risks or outliers I should look at on this page?",
  "Summarise the current view for an exec",
];

const cache = new Map(); // reportId -> string[]

function clearStarterCache(reportId) {
  if (reportId) cache.delete(reportId);
  else cache.clear();
}

async function startersFor(provider, report) {
  if (!report) return FALLBACK_STARTERS;
  const cached = cache.get(report.id);
  if (cached) return cached;
  if (!provider || !report.schemaDescription) return FALLBACK_STARTERS;

  let starters;
  try {
    const raw = await provider.complete({
      system:
        `You write opening questions for a business user who has just opened a ` +
        `dashboard they did not build.\n\n` +
        `Reply with ONLY {"starters":["<question>","<question>","<question>","<question>"]}.\n\n` +
        `Each question must be answerable from this dataset, under nine words, ` +
        `and written in plain business language — never naming a raw measure ` +
        `or column. Make them go somewhere: a comparison, a breakdown, an ` +
        `outlier, a trend. One of the four should be about what is currently ` +
        `on screen rather than about the data as a whole.`,
      messages: [
        {
          role: "user",
          content:
            `What this dashboard is for: ${report.problemStatement || "(not stated)"}\n\n` +
            `The dataset behind it:\n${String(report.schemaDescription).slice(0, 3000)}`,
        },
      ],
      json: true,
      maxTokens: BUDGETS.MAX_TOKENS_ROUTER,
    });
    const parsed = JSON.parse(stripCodeFence(raw));
    const list = (parsed.starters || []).filter((s) => typeof s === "string" && s.trim());
    // Top up rather than show three: an odd-length row reads as a bug.
    starters = [...list, ...FALLBACK_STARTERS].slice(0, 4);
  } catch (err) {
    console.error("[starters] falling back:", err.message);
    // Deliberately not cached — a rate limit now shouldn't cost this report
    // its starters for the life of the process.
    return FALLBACK_STARTERS;
  }

  cache.set(report.id, starters);
  return starters;
}

module.exports = { startersFor, clearStarterCache, FALLBACK_STARTERS };
