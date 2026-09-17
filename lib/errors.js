// Turns a thrown error into something a business user can act on.
//
// Every failure in this app used to reach the chat panel verbatim -- a user
// asking about last quarter's revenue got "Power BI: 400 Query (1, 8) The
// syntax for ')' is incorrect.", which tells them nothing they can do
// anything about. The raw text still travels, under `details`, for whoever is
// debugging; it just stops being the headline.

const MAPPINGS = [
  {
    // AAD tokens are cached and reused, so an expired one surfaces mid-session
    // rather than at load. A reload re-mints it.
    match: (m) => /\b401\b/.test(m) && /power ?bi/i.test(m),
    message: "Lost the connection to Power BI.",
    hint: "Reload the page to reconnect.",
    retryable: false,
  },
  {
    match: (m) => /\b40[34]\b/.test(m) && /(dataset|workspace|report).{0,20}(not ?found|does not exist)/i.test(m),
    message: "Can't reach this report's data.",
    hint: "Check the workspace, report and dataset IDs for this report in admin.",
    retryable: false,
  },
  {
    // Reached only after the pipeline's own retry-with-the-error has already
    // failed, so this is not a transient syntax slip -- it usually means the
    // schema description no longer matches the model.
    match: (m) => /power ?bi/i.test(m) && /\b400\b/.test(m),
    message: "Couldn't write a query that runs against this dataset.",
    hint: "The report's data description in admin may be out of date with the model.",
    retryable: false,
  },
  {
    match: (m) => /\b429\b/.test(m) || /rate.?limit/i.test(m),
    message: "The AI service is busy right now.",
    hint: "Try that again in a moment.",
    retryable: true,
  },
  {
    match: (m) => /\b401\b|\b403\b/.test(m) || /invalid.{0,12}api.?key|incorrect api key/i.test(m),
    message: "The AI service rejected the key.",
    hint: "Check the API key for the chat provider in admin.",
    retryable: false,
  },
  {
    match: (m) => /hit the token limit/i.test(m),
    message: "The AI ran out of room before it answered.",
    hint: "Try a narrower question, or pick a non-reasoning model in admin.",
    retryable: true,
  },
];

function describe(err, context = {}) {
  const details = err && typeof err.message === "string" ? err.message : "";

  for (const mapping of MAPPINGS) {
    if (details && mapping.match(details)) {
      return {
        message: mapping.message,
        hint: mapping.hint,
        retryable: mapping.retryable,
        details,
        ...(context.dax ? { dax: context.dax } : {}),
      };
    }
  }

  return {
    message: "Something went wrong answering that.",
    hint: null,
    retryable: true,
    details,
    ...(context.dax ? { dax: context.dax } : {}),
  };
}

module.exports = { describe };
