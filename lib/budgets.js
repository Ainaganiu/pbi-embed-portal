// lib/budgets.js
//
// Every size and token cap the chat pipeline honours, in one place.
//
// They used to be spread across server.js, lib/chatHelpers.js and
// public/app.js, which made the real cost of a question impossible to see at a
// glance and impossible to tune without hunting. The screen-state caps in
// particular are paid on EVERY question on that path, not only hard ones -- a
// busy page at VISUALS_IN_PROMPT visuals and CHARS_PER_VISUAL characters each
// is a materially larger prompt every turn. Dial them here.

module.exports = Object.freeze({
  // --- screen state sent to the model -------------------------------------
  CHARS_PER_VISUAL: 1200,
  CHARS_FOCUSED_VISUAL: 6000,
  STATE_CHARS: 40000,
  VISUALS_IN_PROMPT: 25,

  // Rows exported per visual out of the embed iframe. Uniform now: the router
  // names the focused visual only after capture has already happened, so
  // capture can no longer treat one visual specially. The focus gets a larger
  // character budget instead.
  EXPORT_ROWS_PER_VISUAL: 30,

  // --- query results -------------------------------------------------------
  RESULT_ROWS: 500,
  RESULT_CHARS: 120000,

  // --- conversation memory -------------------------------------------------
  HISTORY_EXCHANGES_TO_MODEL: 10,
  HISTORY_MESSAGES_ACCEPTED: 20,
  HISTORY_CHARS_PER_TURN: 4000,
  HISTORY_EXCHANGES_STORED: 40,

  // --- provider call ceilings ----------------------------------------------
  // A ceiling, not a target: reasoning models spend completion tokens thinking
  // before emitting anything, and a tight cap truncates them to nothing. The
  // answer-length rules in the prompts are what keep answers short.
  MAX_TOKENS_ANALYSIS: 16000,
  MAX_TOKENS_ROUTER: 400,

  // --- charts --------------------------------------------------------------
  // Past CHART_MAX_CATEGORIES a bar chart stops being readable at any height,
  // so the spec is truncated to the top CHART_TRUNCATE_TO and says so.
  CHART_MAX_CATEGORIES: 18,
  CHART_TRUNCATE_TO: 15,

  // --- model card ----------------------------------------------------------
  // A ceiling for a pathological model, not a target: the reference model
  // fits whole in a fraction of this. Sits against STATE_CHARS above, which
  // is the other large block a prompt can carry.
  MODEL_CARD_CHARS: 20000,
});
