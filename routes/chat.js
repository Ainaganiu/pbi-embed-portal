// routes/chat.js
//
// The single entry point for every chat question.
//
// There used to be three endpoints -- one per answer path -- with the choice
// between them made by regexes in the browser. That made a misroute produce
// the wrong KIND of answer, and it meant streaming, progress, cancellation and
// error handling had to be built three times, so they were built once and the
// other two paths went without.

const express = require("express");
const { getSettings, getReport } = require("../lib/settings");
const { getProvider } = require("../lib/llm");
const { chooseRoute } = require("../lib/route");
const { sanitizeHistory } = require("../lib/chatHelpers");
const { describeFilters } = require("../lib/answer/state");
const { describe: describeError } = require("../lib/errors");

const PIPELINES = {
  screen: require("../lib/answer/screen"),
  query: require("../lib/answer/query"),
  authoring: require("../lib/answer/authoring"),
};

const router = express.Router();

// Every pipeline calls completeStream. Providers without one (Anthropic,
// Gemini) get a shim that emits the finished text as a single delta, so the
// SSE contract holds whatever is configured. Before this, those providers
// simply could not escalate -- the user was told their provider did not
// support it, which is a limitation of the plumbing, not of the model.
function withStreaming(provider) {
  if (!provider || typeof provider.completeStream === "function") return provider;
  return {
    ...provider,
    async completeStream(request, onDelta) {
      const text = await provider.complete(request);
      onDelta(text);
      return text;
    },
  };
}

router.post("/", async (req, res) => {
  const { reportId, question, state } = req.body || {};
  const history = sanitizeHistory(req.body && req.body.history);

  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(reportId);
  } catch (err) {
    return res.status(503).json({ error: `Configuration unavailable: ${err.message}` });
  }
  if (!report) return res.status(404).json({ error: `Unknown report "${reportId}"` });
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing question" });
  }

  const provider = withStreaming(
    getProvider({
      provider: settings.llmProvider,
      apiKey: settings.llmApiKey,
      model: settings.llmModel,
      apiBase: settings.llmApiBase,
    })
  );
  if (!provider) return res.status(400).json({ error: `Chat is not enabled for report "${reportId}"` });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // The client aborts the fetch when the user presses stop. Checking this
  // before each provider and Power BI call is what makes stopping stop the
  // spending, rather than only hiding the result.
  let cancelled = false;
  req.on("close", () => { cancelled = true; });
  const aborted = () => cancelled;

  let route;
  try {
    emit({ stage: "routing" });
    route = await chooseRoute(provider, {
      question,
      history,
      pageName: state?.pageName,
      visualTitles: (state?.visuals || []).map((v) => ({ name: v.name, title: v.title, type: v.type })),
      filterSummary: describeFilters([...(state?.reportFilters || []), ...(state?.pageFilters || [])]),
      schemaOutline: report.schemaDescription,
      hasDataset: Boolean(report.datasetId && report.schemaDescription),
    });
    console.error(`[route] ${route.path} (${route.confidence}) — ${route.reason}`);

    if (aborted()) return res.end();

    const done = await PIPELINES[route.path].run(
      { report, settings, provider, question, history, state, focusVisual: route.focusVisual, aborted },
      emit
    );
    emit({ done: true, ...done, route: route.path });
  } catch (err) {
    if (aborted()) return res.end();
    console.error(`[chat] ${route ? route.path : "routing"} failed:`, err.message);
    emit({ error: describeError(err, { dax: err.dax }) });
  }
  res.end();
});

module.exports = router;
