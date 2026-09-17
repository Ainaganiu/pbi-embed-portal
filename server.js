require("dotenv/config");
const path = require("node:path");
const express = require("express");
const session = require("express-session");

const { migrate } = require("./lib/db");
const { syncAdminFromEnv } = require("./lib/auth");
const { getSettings, getReports, getReport } = require("./lib/settings");
const { generateEmbedToken } = require("./lib/powerbi");
const { getProvider } = require("./lib/llm");
const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");
const { sanitizeHistory } = require("./lib/chatHelpers");
const screenAnswer = require("./lib/answer/screen");
const queryAnswer = require("./lib/answer/query");
const authoringAnswer = require("./lib/answer/authoring");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-insecure-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
function settingsUnavailable(res, err) {
  res.status(503).json({ error: `Settings database unavailable: ${err.message}` });
}

function chatEnabledFor(report, settings) {
  return Boolean(getProvider({
    provider: settings.llmProvider,
    apiKey: settings.llmApiKey,
  }) && report?.datasetId && report?.schemaDescription);
}

// Branding — used by the public portal to render name/logo/accent color.
app.get("/api/branding", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      portalName: settings.portalName,
      logoDataUri: settings.logoDataUri,
      accentColor: settings.accentColor,
    });
  } catch (err) {
    settingsUnavailable(res, err);
  }
});

// List reports available to embed, and whether each has chat/chart enabled.
app.get("/api/reports", async (req, res) => {
  try {
    const [settings, reports] = await Promise.all([getSettings(), getReports()]);
    res.json(
      reports.map((r) => ({
        id: r.id,
        name: r.name,
        hasChat: chatEnabledFor(r, settings),
      }))
    );
  } catch (err) {
    settingsUnavailable(res, err);
  }
});

// Mint a short-lived embed token for a given report.
app.get("/api/embed-token/:id", async (req, res) => {
  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(req.params.id);
  } catch (err) {
    return settingsUnavailable(res, err);
  }
  if (!report) {
    return res.status(404).json({ error: `Unknown report "${req.params.id}"` });
  }

  try {
    const token = await generateEmbedToken(
      { tenantId: settings.pbiTenantId, clientId: settings.pbiClientId, clientSecret: settings.pbiClientSecret },
      { workspaceId: report.workspaceId, reportId: report.reportId }
    );
    res.json(token);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// problemContext, sanitizeHistory and stripCodeFence now live in
// lib/chatHelpers.js, shared with the authoring route.

// Temporary: replaced by routes/chat.js in the front-door commit.
app.post("/api/chat/visual", async (req, res) => {
  const { reportId, question, state } = req.body || {};
  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(reportId);
  } catch (err) {
    return settingsUnavailable(res, err);
  }
  if (!report) return res.status(404).json({ error: `Unknown report "${reportId}"` });
  if (!question || typeof question !== "string") return res.status(400).json({ error: "Missing question" });

  const provider = getProvider({
    provider: settings.llmProvider,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    apiBase: settings.llmApiBase,
  });
  if (!provider) return res.status(400).json({ error: `Chat is not enabled for report "${reportId}"` });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let cancelled = false;
  req.on("close", () => { cancelled = true; });

  try {
    const done = await screenAnswer.run(
      {
        report, settings, provider, question, state,
        history: sanitizeHistory(req.body && req.body.history),
        focusVisual: null,
        aborted: () => cancelled,
      },
      emit
    );
    emit({ done: true, ...done });
  } catch (err) {
    emit({ error: { message: `Visual analysis failed: ${err.message}`, hint: null, retryable: true, details: err.message } });
  }
  res.end();
});


// Temporary: replaced by routes/chat.js in the front-door commit.
app.post("/api/chat", async (req, res) => {
  const { reportId, question } = req.body || {};
  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(reportId);
  } catch (err) {
    return settingsUnavailable(res, err);
  }
  if (!report) return res.status(404).json({ error: `Unknown report "${reportId}"` });
  if (!chatEnabledFor(report, settings)) {
    return res.status(400).json({ error: `Chat is not enabled for report "${reportId}"` });
  }
  if (!question || typeof question !== "string") return res.status(400).json({ error: "Missing question" });

  const provider = getProvider({
    provider: settings.llmProvider,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    apiBase: settings.llmApiBase,
  });
  if (!provider) return res.status(400).json({ error: `Chat is not enabled for report "${reportId}"` });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}

`);

  let cancelled = false;
  req.on("close", () => { cancelled = true; });

  try {
    const done = await queryAnswer.run(
      {
        report, settings, provider, question, state: null,
        history: sanitizeHistory(req.body && req.body.history),
        focusVisual: null,
        aborted: () => cancelled,
      },
      emit
    );
    emit({ done: true, ...done });
  } catch (err) {
    emit({ error: { message: `Query failed: ${err.message}`, hint: null, retryable: true, details: err.message } });
  }
  res.end();
});

// Temporary: replaced by routes/chat.js in the front-door commit.
app.post("/api/chat/authoring", async (req, res) => {
  const { reportId, question } = req.body || {};
  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(reportId);
  } catch (err) {
    return settingsUnavailable(res, err);
  }
  if (!report) return res.status(404).json({ error: `Unknown report "${reportId}"` });
  if (!question || typeof question !== "string") return res.status(400).json({ error: "Missing question" });

  const provider = getProvider({
    provider: settings.llmProvider,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    apiBase: settings.llmApiBase,
  });
  if (!provider) return res.status(400).json({ error: `Chat is not enabled for report "${reportId}"` });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  let cancelled = false;
  req.on("close", () => { cancelled = true; });

  try {
    const done = await authoringAnswer.run(
      {
        report, settings, provider, question, state: null,
        history: sanitizeHistory(req.body && req.body.history),
        focusVisual: null,
        aborted: () => cancelled,
      },
      emit
    );
    emit({ done: true, ...done });
  } catch (err) {
    emit({ error: { message: `Authoring help failed: ${err.message}`, hint: null, retryable: true, details: err.message } });
  }
  res.end();
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message || "Internal server error" });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  migrate()
    .then(() => syncAdminFromEnv())
    .catch((err) => {
      console.error("Database migration failed at startup (will retry lazily on first request):", err.message);
    })
    .finally(() => {
      app.listen(port, () => {
        console.log(`pbi-embed-portal listening on http://localhost:${port}`);
      });
    });
}

module.exports = app;
