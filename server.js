require("dotenv/config");
const path = require("node:path");
const express = require("express");
const session = require("express-session");

const { migrate } = require("./lib/db");
const { syncAdminFromEnv } = require("./lib/auth");
const { getSettings, getReports, getReport } = require("./lib/settings");
const { generateEmbedToken, executeQuery } = require("./lib/powerbi");
const { getProvider } = require("./lib/llm");
const llmCache = require("./lib/llmCache");
const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");

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

const MAX_RESULT_ROWS = 50;
const MAX_RESULT_CHARS = 20_000;

function stripCodeFence(text) {
  return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
}

// Question -> DAX -> query -> text answer + optional chart spec.
app.post("/api/chat", async (req, res) => {
  const { reportId, question } = req.body || {};

  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(reportId);
  } catch (err) {
    return settingsUnavailable(res, err);
  }

  if (!report) {
    return res.status(404).json({ error: `Unknown report "${reportId}"` });
  }
  if (!chatEnabledFor(report, settings)) {
    return res.status(400).json({ error: `Chat is not enabled for report "${reportId}"` });
  }
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing question" });
  }

  const cached = llmCache.get(reportId, question);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  const provider = getProvider({ provider: settings.llmProvider, apiKey: settings.llmApiKey, model: settings.llmModel, apiBase: settings.llmApiBase });
  const pbiCredentials = {
    tenantId: settings.pbiTenantId,
    clientId: settings.pbiClientId,
    clientSecret: settings.pbiClientSecret,
  };
  const schemaDescription = report.schemaDescription;
  let dax;

  try {
    dax = stripCodeFence(
      await provider.complete({
        system:
          `You are a DAX query generator for a Power BI dataset. Given a ` +
          `question, return ONLY a single valid DAX query (an EVALUATE ` +
          `statement) that answers it. No prose, no markdown fences, no ` +
          `explanation.\n\nDataset schema:\n${schemaDescription}`,
        messages: [{ role: "user", content: question }],
        // DAX queries are short — cap generation well below the default to
        // avoid paying for a rambling response.
        maxTokens: 300,
      })
    );
  } catch (err) {
    return res.status(502).json({ error: `LLM DAX generation failed: ${err.message}` });
  }

  let rows;
  try {
    rows = await executeQuery(pbiCredentials, {
      workspaceId: report.workspaceId,
      datasetId: report.datasetId,
      dax,
    });
  } catch (err) {
    return res.status(502).json({ error: `Power BI query failed: ${err.message}`, dax });
  }

  const rowCount = rows.length;
  let rowsForPrompt = JSON.stringify(rows.slice(0, MAX_RESULT_ROWS));
  if (rowsForPrompt.length > MAX_RESULT_CHARS) {
    rowsForPrompt = rowsForPrompt.slice(0, MAX_RESULT_CHARS);
  }

  let answer = "";
  let chart = null;
  try {
    const raw = await provider.complete({
      system:
        `You answer questions about Power BI query results. Given the ` +
        `user's question and the raw result rows (JSON), respond with ONLY ` +
        `a JSON object of the form:\n` +
        `{"answer": "<short plain-English answer>", "chart": {"type": "bar"|"line", "labels": [...], "values": [...], "label": "<series label>"} | null}\n` +
        `Set "chart" to null if the data doesn't call for a chart (e.g. a ` +
        `single number or yes/no answer). Do not include markdown fences.`,
      messages: [
        {
          role: "user",
          content: `Question: ${question}\n\nResult rows (JSON): ${rowsForPrompt}`,
        },
      ],
      json: true,
      // Enough room for a short answer + a chart with a few dozen points,
      // without leaving the response length uncapped.
      maxTokens: 700,
    });

    const parsed = JSON.parse(stripCodeFence(raw));
    answer = parsed.answer ?? "";
    chart = parsed.chart ?? null;
  } catch (err) {
    // Fall back to raw text rather than 500ing — the DAX + rows already
    // succeeded, so surface something useful.
    answer = err instanceof SyntaxError
      ? "The model's answer couldn't be parsed as JSON; showing the generated DAX and row count instead."
      : `LLM answer generation failed: ${err.message}`;
  }

  const result = { answer, chart, dax, rowCount };
  llmCache.set(reportId, question, result);
  res.json(result);
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
