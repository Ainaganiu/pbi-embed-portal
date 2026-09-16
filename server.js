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

// Business context the admin wrote for a report. It's cached in memory with
// the rest of the report config, and prepended to every prompt so answers stay
// anchored to what the dashboard is actually for.
function problemContext(report) {
  if (!report.problemStatement) return "";
  return `Business context for this dashboard — keep this in mind throughout:
${report.problemStatement}

`;
}

// Prior turns arrive from the browser, so treat them as untrusted input:
// keep only the expected shape, cap the length, and cap each message.
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_CHARS = 1500;

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));
}

function stripCodeFence(text) {
  return text.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
}

// ---------------------------------------------------------------------------
// Visual-context path: answering "what is this telling me?" about whatever the
// user currently has on screen.
//
// Power BI renders into a cross-origin iframe, so the page's pixels can't be
// read client-side, and this tenant has report-to-image export disabled. So
// instead of a screenshot we take the structured state the embed SDK does
// expose — active page, filters/slicers, and each visual's own exported data —
// and reason over that. It also means the model sees exact figures rather than
// numbers recovered from an image.
// ---------------------------------------------------------------------------

// High enough to cover a full dashboard page — the point of this path is to
// read everything on screen, not a sample of it. The per-visual cap is
// deliberately tight: for "what is this telling me?" the top few rows carry
// the story, and trimming the payload cuts response time substantially,
// because the model's reasoning scales with how much data it is handed.
const MAX_VISUALS_IN_PROMPT = 25;
const MAX_CHARS_PER_VISUAL = 300;
// When the question is about one specific visual, that visual is the answer,
// so it gets room for its full row set while the rest stay as brief context.
const MAX_CHARS_FOCUSED_VISUAL = 1800;
const MAX_STATE_CHARS = 7500;

function describeFilters(filters) {
  if (!Array.isArray(filters) || filters.length === 0) return "none";
  return filters
    .map((f) => {
      const col = f?.target?.column || f?.target?.measure || f?.target?.hierarchy || "filter";
      const table = f?.target?.table ? `${f.target.table}.` : "";
      const values = Array.isArray(f.values) ? f.values.join(", ") : f.value ?? "";
      const op = f.operator || f.conditions?.[0]?.operator || "is";
      return `${table}${col} ${op} ${values}`.trim();
    })
    .join("; ");
}

function renderReportState(state) {
  const lines = [];
  lines.push(`Active page: ${state.pageName || "(unknown)"}`);
  lines.push(`Report-level filters: ${describeFilters(state.reportFilters)}`);
  lines.push(`Page-level filters: ${describeFilters(state.pageFilters)}`);

  const visuals = (state.visuals || []).slice(0, MAX_VISUALS_IN_PROMPT);
  lines.push(`\nVisuals currently on this page (${(state.visuals || []).length}):`);

  visuals.forEach((v, i) => {
    const focusTag = v.focus ? "   <-- THE VISUAL THE QUESTION IS ABOUT" : "";
    lines.push(`\n${i + 1}. "${v.title || "(untitled)"}" — ${v.type || "unknown type"}${focusTag}`);
    if (v.slicerState) lines.push(`   slicer selection: ${v.slicerState}`);
    if (v.visualFilters) lines.push(`   filters on this visual: ${describeFilters(v.visualFilters)}`);
    if (v.error) lines.push(`   (data unavailable: ${v.error})`);
    else if (v.data) {
      const cap = v.focus ? MAX_CHARS_FOCUSED_VISUAL : MAX_CHARS_PER_VISUAL;
      lines.push(`   data:\n${String(v.data).slice(0, cap)}`);
    }
  });

  if ((state.visuals || []).length > MAX_VISUALS_IN_PROMPT) {
    lines.push(`\n(${state.visuals.length - MAX_VISUALS_IN_PROMPT} further visuals omitted.)`);
  }
  return lines.join("\n").slice(0, MAX_STATE_CHARS);
}

app.post("/api/chat/visual", async (req, res) => {
  const { reportId, question, state } = req.body || {};
  const priorTurns = sanitizeHistory(req.body && req.body.history);

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
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing question" });
  }

  const provider = getProvider({
    provider: settings.llmProvider,
    apiKey: settings.llmApiKey,
    model: settings.llmModel,
    apiBase: settings.llmApiBase,
  });
  if (!provider) {
    return res.status(400).json({ error: `Chat is not enabled for report "${reportId}"` });
  }

  const stateText = renderReportState(state || {});

  const focused = (state?.visuals || []).find((v) => v && v.focus);
  const visualContext = {
    pageName: state?.pageName || null,
    visualCount: (state?.visuals || []).length,
    focusTitle: focused ? focused.title : null,
    // Report- and page-level filters both narrow what's on screen, so the
    // "what was read" line has to account for both.
    filters: describeFilters([
      ...(state?.reportFilters || []),
      ...(state?.pageFilters || []),
    ]),
  };

  try {
    const request = {
      system:
        problemContext(report) +
        `You are an experienced data analyst reviewing a Power BI report on ` +
        `behalf of a business user who is looking at it right now.\n\n` +
        `You will be shown the current state of the report page they have ` +
        `open — the active page, the filters and slicers they have applied, ` +
        `and each visual on that page together with the data it is currently ` +
        `displaying — along with their question.\n\n` +
        `When you respond:\n` +
        `- Speak to what matters, not what's visible. Don't narrate chart ` +
        `types or describe the layout ("there is a bar chart showing…") — go ` +
        `straight to what the data means.\n` +
        `- Lead with the headline. State the single most important takeaway ` +
        `first, in one sentence, before any supporting detail.\n` +
        `- Read the whole page as one picture, not chart-by-chart. If ` +
        `multiple visuals are shown, connect them — note where they agree, ` +
        `where they contradict, and what that combination implies.\n` +
        `- Flag what's notable. Call out outliers, inflection points, or ` +
        `numbers that look off given the current filters — but only if they ` +
        `are actually present in the data below. Never invent a number you ` +
        `cannot see.\n` +
        `- Respect the current filter/slicer state. Frame your answer in ` +
        `terms of what is actually being shown, naming the active filters in ` +
        `plain business terms ("with 2016 selected…"). If nothing is ` +
        `filtered, say the figures cover everything. Never present filtered ` +
        `numbers as if they were the whole dataset.\n` +
        `- If a visual is marked as THE VISUAL THE QUESTION IS ABOUT, answer ` +
        `about that visual. Do not recap the rest of the page; bring in ` +
        `another visual only where it directly explains the one asked about.\n` +
        `- Match the question's scope. A broad question ("what is this ` +
        `telling me?") gets a short, prioritized summary — 2-4 sentences, ` +
        `most important first. A specific question about one part of the ` +
        `screen gets a direct, focused answer, not a full-page recap.\n` +
        `- Say what you can't see. If the question asks about something not ` +
        `present in the current view (a different page, a filter that isn't ` +
        `applied), say so plainly rather than guessing.\n` +
        `- No jargon, no hedging filler. Write like you're briefing a ` +
        `colleague who needs the point, not a caveat-laden disclaimer.\n\n` +
        `Keep the full response under 100 words unless the user's question ` +
        `explicitly asks for more detail. Reply with prose only — no JSON, ` +
        `no markdown headings.\n\n` +
        `Background on the underlying model (for context only; the current ` +
        `view above is what the user is asking about):\n` +
        `${(report.schemaDescription || "(not described)").slice(0, 2500)}`,
      messages: [
        ...priorTurns,
        { role: "user", content: `Current report state:\n${stateText}\n\nQuestion: ${question}` },
      ],
      maxTokens: 5000,
    };

    // Stream when the provider supports it. The model dominates the wait, so
    // emitting text as it's produced is the difference between ten seconds of
    // blank panel and an answer that starts almost immediately.
    if (typeof provider.completeStream === "function") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      try {
        const answer = await provider.completeStream(request, (delta) => send({ delta }));
        send({ done: true, answer: answer.trim(), visualContext });
      } catch (err) {
        send({ error: `Visual analysis failed: ${err.message}` });
      }
      return res.end();
    }

    const answer = await provider.complete(request);
    res.json({ answer: answer.trim(), chart: null, visualContext });
  } catch (err) {
    res.status(502).json({ error: `Visual analysis failed: ${err.message}` });
  }
});

// Question -> DAX -> query -> text answer + optional chart spec.
app.post("/api/chat", async (req, res) => {
  const { reportId, question } = req.body || {};
  const priorTurns = sanitizeHistory(req.body && req.body.history);

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

  // Only reuse a cached answer for a standalone question. Once there are
  // prior turns, the same words can mean something different ("and 2022?"),
  // so a cache keyed on the question alone would return the wrong answer.
  const cached = priorTurns.length === 0 ? llmCache.get(reportId, question) : null;
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
    problemContext(report) +
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
    `Ask before guessing. If the question doesn't identify which measure, ` +
    `column, filter or time period it means, and picking wrongly would give ` +
    `a materially different answer, do NOT write a query. Instead reply with ` +
    `exactly:\n` +
    `CLARIFY: <one short question naming the options>\n` +
    `For example "which measure did you mean — revenue or units?" or "which ` +
    `year should I use?". Offer the real options where you can, but name them ` +
    `in plain business language — never expose raw measure or column syntax ` +
    `like [1_ Total Interactions] or 'Table'[Column] to the user. Ask at most ` +
    `one question, and keep it to a single sentence.\n` +
    `Do not ask when a sensible reading is obvious: a question naming one ` +
    `measure, or one that clearly means the whole dataset, should just be ` +
    `answered. Earlier turns in the conversation count as context — if they ` +
    `already establish the measure or period, use it rather than asking ` +
    `again.\n\n` +
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
    dax = await generateDax([...priorTurns, { role: "user", content: question }]);

    // The model can decline to guess when the question doesn't pin down a
    // measure, filter or period. Return the question it asked instead of
    // querying — a wrong number presented confidently is worse than a
    // one-line clarification.
    const clarify = dax.match(/^\s*CLARIFY:\s*(.+)$/is);
    if (clarify) {
      return res.json({
        answer: clarify[1].trim().replace(/\s+/g, " "),
        chart: null,
        clarify: true,
      });
    }
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
        ...priorTurns,
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
        problemContext(report) +
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
          // The DAX matters here: with conversation history a question can be
          // as bare as "and 2023?", and without seeing the query the model
          // can't tell what period or filter the rows actually represent.
          content:
            `Question: ${question}\n\n` +
            `Query that produced these rows:\n${dax}\n\n` +
            `Result rows (JSON): ${rowsForPrompt}`,
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
  if (priorTurns.length === 0) llmCache.set(reportId, question, result);
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
