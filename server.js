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

  const daxSystemPrompt =
    `You are a DAX query generator for a Power BI dataset. Given a question, ` +
    `return ONLY a single valid DAX query (an EVALUATE statement) that ` +
    `answers it. No prose, no markdown fences, no explanation.\n\n` +
    `Rules — these prevent the most common failures:\n` +
    `- ALWAYS wrap table names in single quotes: 'DataTable'[Column], not ` +
    `DataTable[Column]. This is required even when the name has no spaces.\n` +
    `- A boolean filter argument to CALCULATE/CALCULATETABLE must be a simple ` +
    `comparison on ONE column, e.g. 'T'[Col] = "X". An expression such as ` +
    `YEAR('T'[Date]) = 2023 is INVALID there — wrap it in FILTER instead: ` +
    `FILTER('T', YEAR('T'[Date]) = 2023).\n` +
    `- If the model has a date/calendar dimension table, filter time using ` +
    `its columns (e.g. 'Date'[Year] = 2023) rather than applying YEAR() to a ` +
    `fact-table date column.\n` +
    `- Use only tables, columns and measures named in the schema below. Never ` +
    `invent names, and match their spelling and capitalisation exactly, ` +
    `including any numeric or underscore prefixes on measures.\n` +
    `- Filter values must match the data exactly. If the schema lists the ` +
    `allowed values for a column, use one of those literally.\n` +
    `- Prefer existing measures over re-aggregating raw columns.\n\n` +
    `Dataset schema:\n${schemaDescription}`;

  async function generateDax(messages) {
    return stripCodeFence(
      await provider.complete({
        system: daxSystemPrompt,
        messages,
        // A DAX query itself is short, but reasoning models spend completion
        // tokens on hidden reasoning first — a tight cap truncates them to
        // nothing. This is a ceiling, not a target: non-reasoning models stop
        // as soon as the query is written and never reach it.
        maxTokens: 5000,
      })
    );
  }

  let dax;
  try {
    dax = await generateDax([{ role: "user", content: question }]);
  } catch (err) {
    return res.status(502).json({ error: `LLM DAX generation failed: ${err.message}` });
  }

  // Run the query, and on a Power BI rejection give the model one chance to
  // correct itself with the error in hand. Most failures are mechanical
  // (an unquoted table name, an expression used as a CALCULATE filter) and
  // the model fixes them reliably once it can see what the engine said.
  let rows;
  try {
    rows = await executeQuery(pbiCredentials, {
      workspaceId: report.workspaceId,
      datasetId: report.datasetId,
      dax,
    });
  } catch (firstErr) {
    const firstDax = dax;
    try {
      dax = await generateDax([
        { role: "user", content: question },
        { role: "assistant", content: firstDax },
        {
          role: "user",
          content:
            `That query was rejected by Power BI with this error:\n\n` +
            `${firstErr.message}\n\n` +
            `Return a corrected DAX query. Check table-name quoting, that ` +
            `CALCULATE filters are simple column comparisons, and that every ` +
            `column, measure and filter value exists in the schema exactly as ` +
            `written. Return ONLY the query.`,
        },
      ]);
      rows = await executeQuery(pbiCredentials, {
        workspaceId: report.workspaceId,
        datasetId: report.datasetId,
        dax,
      });
    } catch (retryErr) {
      return res.status(502).json({
        error: `Power BI query failed: ${retryErr.message}`,
        dax,
      });
    }
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
        `You are a data analyst presenting findings to a business audience. ` +
        `You are given a question and the raw result rows (JSON) from a Power ` +
        `BI query. Respond with ONLY a JSON object of the form:\n` +
        `{"answer": "<your analysis, as markdown>", "chart": {"type": "bar"|"line"|"pie"|"card", "labels": [...], "values": [...], "label": "<series or caption label>"} | null}\n\n` +
        `Write "answer" as a short analyst narrative in three beats:\n` +
        `1. A headline finding on its own line, wrapped in ** ** — the single ` +
        `most important thing the numbers say.\n` +
        `2. One or two sentences of supporting detail: cite the actual ` +
        `figures, and where the data allows it, add comparison or context ` +
        `(biggest vs smallest, share of total, change over time, how one ` +
        `group stacks up against the rest).\n` +
        `3. A final sentence starting with "What this means:" giving the ` +
        `practical takeaway.\n\n` +
        `Style: plain business English, no jargon, no preamble like "Based on ` +
        `the data". Format numbers readably with thousands separators. Keep ` +
        `the whole answer under about 90 words.\n\n` +
        `Be honest about limits. If the rows are empty, say the query ` +
        `returned no data and suggest what might be wrong (e.g. a filter ` +
        `value that matches nothing) rather than inventing a finding. If a ` +
        `trend rests on very few points, or the question can't be fully ` +
        `answered from these rows, say so plainly instead of overstating it. ` +
        `Never state a number that is not present in the rows.\n\n` +
        `Pick the chart type that fits the data:\n` +
        `- "card": a single headline number (e.g. a total or a count). Put ` +
        `the number in values as a one-element array and a short caption in ` +
        `"label"; "labels" may be omitted.\n` +
        `- "bar": comparing a measure across categories.\n` +
        `- "line": a trend over time or an ordered sequence.\n` +
        `- "pie": parts of a whole, only when there are 2-8 categories that ` +
        `sum to a meaningful total.\n` +
        `Use null only when the answer is genuinely not numeric (e.g. yes/no ` +
        `or a plain text explanation). "labels" and "values" must be the ` +
        `same length for bar, line and pie. Do not include markdown fences.`,
      messages: [
        {
          role: "user",
          content: `Question: ${question}\n\nResult rows (JSON): ${rowsForPrompt}`,
        },
      ],
      json: true,
      // Room for a short answer plus a chart spec, with headroom for
      // reasoning models (see the note on the DAX call above).
      maxTokens: 5000,
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
