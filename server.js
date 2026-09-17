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
const authoringRouter = require("./routes/authoring");
const { CORE_RULES } = require("./lib/daxSkills");
const { groundingIssues } = require("./lib/daxLint");
const { chooseChartType } = require("./lib/chartChoice");
const {
  problemContext,
  sanitizeHistory,
  stripCodeFence,
  parseClarify,
  findClarify,
} = require("./lib/chatHelpers");
const BUDGETS = require("./lib/budgets");
const screenAnswer = require("./lib/answer/screen");
const { buildDaxSystemPrompt } = require("./lib/answer/dax");

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
app.use("/api/chat/authoring", authoringRouter);

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

  const daxSystemPrompt = buildDaxSystemPrompt(report);

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
    const clarifyInDax = findClarify(dax);
    if (clarifyInDax) {
      const questions = parseClarify(clarifyInDax.payload);
      return res.json({
        // A comparison usually leaves several things open, so each open axis
        // comes back as its own question with suggested answers.
        answer:
          clarifyInDax.lead ||
          (questions.length > 1
            ? "A couple of things would change the answer:"
            : questions[0].ask),
        questions,
        chart: null,
        clarify: true,
      });
    }
  } catch (err) {
    return res.status(502).json({ error: `LLM DAX generation failed: ${err.message}` });
  }

  // A query can be perfectly valid and still answer a different question —
  // "top 10 genres in 2016" returning all-time totals runs fine and reads as
  // an answer. The engine will never complain, so check before running it.
  try {
    const issues = groundingIssues(question, dax);
    if (issues.length) {
      console.error("[grounding]", issues.join("; "));
      dax = await generateDax([
        ...priorTurns,
        { role: "user", content: question },
        { role: "assistant", content: dax },
        {
          role: "user",
          content:
            `That query does not answer the question: ${issues.join("; ")}.\n\n` +
            `Apply the filter as a real filter — through the model's date ` +
            `dimension where it is a period — rather than naming a column ` +
            `after it. Return ONLY the corrected query.`,
        },
      ]);
    }
  } catch (err) {
    // The first query is still runnable; a failed correction shouldn't lose it.
    console.error("[grounding] correction failed:", err.message);
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
  let rowsForPrompt = JSON.stringify(rows.slice(0, BUDGETS.RESULT_ROWS));
  if (rowsForPrompt.length > BUDGETS.RESULT_CHARS) {
    rowsForPrompt = rowsForPrompt.slice(0, BUDGETS.RESULT_CHARS);
  }

  let answer = "";
  let chart = null;
  let followUps = [];
  try {
    const raw = await provider.complete({
      system:
        problemContext(report) +
        `You are a data analyst presenting findings to a business audience. ` +
        `You are given a question and the raw result rows (JSON) from a Power ` +
        `BI query. Respond with ONLY a JSON object of the form:\n` +
        `{"answer": "<your analysis, as markdown>", "chart": {"type": "column"|"bar"|"line"|"donut"|"card"|"table"|"variance", "labels": [...], "unit": "<e.g. $K, tickets>", "values": [...], "label": "<caption>"} | null, "followUps": ["<question>", "<question>", "<question>"]}\n\n` +
        `"followUps" are three questions this answer naturally leads to, each ` +
        `answerable from this same report and under nine words. Prefer ones ` +
        `that go somewhere new — a breakdown, a comparison, a cause — rather ` +
        `than a restatement of what you just said. Always include them.\n\n` +
        `Charts follow IBCS notation. When you have more than one scenario, ` +
        `use "series" instead of "values", tagging each one:\n` +
        `"series": [{"name":"2016","scenario":"AC","values":[...]},{"name":"2015","scenario":"PY","values":[...]}]\n` +
        `Scenarios: AC = actual, PY = previous year, PL = plan/budget, ` +
        `FC = forecast. Tag them correctly — the fill carries that meaning, so ` +
        `a mislabelled series reads as the wrong thing entirely.\n` +
        `Always set "unit" when the figures have one; it goes in the title ` +
        `rather than being repeated on every label.\n` +
        `A "table" may instead carry "columns" and "rows" for arbitrary ` +
        `tabular output. When a table is given AC and PY series it gains ` +
        `variance columns automatically — you don't need to compute them.\n\n` +
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
        `Choosing the chart type — work down this list and take the FIRST ` +
        `rule that applies. One rule underpins all of it: vertical is for ` +
        `TIME, horizontal is for STRUCTURE. Never use one for the other.\n` +
        `1. One row with one number -> "card". Put the number in values as a ` +
        `one-element array and a short caption in "label"; omit "labels".\n` +
        `2. Two or more measures per item (this year beside last year, a ` +
        `count beside a percentage) -> "table". Use "columns" and "rows" for ` +
        `the multi-column case.\n` +
        `3. The categories are periods (years, quarters, months, dates):\n` +
        `   - seven or more periods -> "line", the trend is the message;\n` +
        `   - fewer than seven -> "column", vertical, one per period.\n` +
        `4. The question is about a change or a gap, and you have both an ` +
        `actual and a comparison -> "variance". Give AC and PY series and it ` +
        `draws the difference from a zero line, green where positive and red ` +
        `where negative. Plot the difference, not the two totals.\n` +
        `5. The question is about a share, split or mix, over 2 to 6 ` +
        `categories that sum to a meaningful whole -> "donut".\n` +
        `6. Anything else comparing a measure across categories -> "bar", ` +
        `horizontal. This is the default; above about 12 categories it is the ` +
        `only readable option, because column labels collide.\n` +
        `Use null only when the answer is genuinely not numeric (e.g. yes/no ` +
        `or a plain text explanation). "labels" and "values" must be the ` +
        `same length for bar, line and donut. Do not include markdown fences.`,
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
    followUps = Array.isArray(parsed.followUps) ? parsed.followUps.slice(0, 3) : [];

    // The shape of the result decides the chart in the cases that have one
    // right answer — a single number is a card however the question was
    // phrased, and time goes on a vertical axis whatever the model suggests.
    // Everything else is left to its judgement, which is where the question's
    // wording genuinely matters. See lib/chartChoice.js.
    const choice = chooseChartType(question, rows);
    if (chart && choice.fixed && choice.type && chart.type !== choice.type) {
      console.error(
        `[chart] overriding "${chart.type}" with "${choice.type}" — ${choice.reason}`
      );
      chart.type = choice.type;
    } else if (chart && !chart.type && choice.type) {
      chart.type = choice.type;
    }
  } catch (err) {
    // Fall back to raw text rather than 500ing — the DAX + rows already
    // succeeded, so surface something useful.
    answer = err instanceof SyntaxError
      ? "The model's answer couldn't be parsed as JSON; showing the generated DAX and row count instead."
      : `LLM answer generation failed: ${err.message}`;
  }

  const result = { answer, chart, dax, rowCount, followUps };
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
