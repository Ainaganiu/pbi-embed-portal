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
const { lintDax, groundingIssues } = require("./lib/daxLint");
const { chooseChartType } = require("./lib/chartChoice");
const {
  problemContext,
  sanitizeHistory,
  stripCodeFence,
  parseClarify,
  findClarify,
  FOLLOW_UP_RULE,
  splitFollowUps,
  emitSafe,
} = require("./lib/chatHelpers");

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

const MAX_RESULT_ROWS = 50;
const MAX_RESULT_CHARS = 20_000;

// problemContext, sanitizeHistory and stripCodeFence now live in
// lib/chatHelpers.js, shared with the authoring route.

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

// The entities the user can actually see. Without these, a follow-up query for
// "these games in 2015" would return 2015's own top five — a different question
// that looks like an answer.
const MAX_ENTITIES = 25;

function entitiesOnScreen(state) {
  const visuals = state?.visuals || [];
  // Prefer the visual the question was about; otherwise the first one with a
  // categorical first column.
  const candidates = [...visuals].sort((a, b) => (b.focus ? 1 : 0) - (a.focus ? 1 : 0));

  for (const v of candidates) {
    if (!v.data || v.type === "slicer") continue;
    const lines = String(v.data).trim().split(/\r?\n/);
    if (lines.length < 2) continue;

    const values = lines
      .slice(1)
      .map((line) => (line.match(/^("([^"]*)"|[^,]*)/) || [])[0] || "")
      .map((s) => s.replace(/^"|"$/g, "").trim())
      .filter((s) => s && !/^-?[\d.,]+$/.test(s)); // skip numeric first columns

    if (values.length >= 2) {
      return { visualTitle: v.title, header: lines[0].split(",")[0].trim(), values: values.slice(0, MAX_ENTITIES) };
    }
  }
  return null;
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

function buildDaxSystemPrompt(report, opts = {}) {
  const schemaDescription = report.schemaDescription;
  return (
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
    // Escalation from the visual path already knows exactly what it needs, so
    // a clarifying question there would stall a request the user never sees.
    (opts.allowClarify === false
      ? `The request below already states precisely what is needed. Always ` +
        `return a query — never ask a clarifying question.\n\n`
      : `Ask before guessing. If the question doesn't identify which measure, ` +
        `column, filter or time period it means, and picking wrongly would give ` +
        `a materially different answer, do NOT write a query. Instead reply with ` +
        `a single line of exactly this shape:\n` +
        `CLARIFY: {"questions":[{"ask":"<short question>","multi":false,"options":["<option>","<option>"]}]}\n` +
        `A comparison is the usual case: "compare these" leaves open what to ` +
        `compare against, on which measure, and over which period. Ask each ` +
        `open axis as its own question so they can all be answered at once — ` +
        `at most 3 questions, each with 2 to 6 options.\n` +
        `Set "multi":true where several answers genuinely make sense together ` +
        `(which measures to include, which regions to cover) and false where ` +
        `only one can apply (which axis, which single period). The user ticks ` +
        `them, so this decides whether they may tick more than one.\n` +
        `Example: CLARIFY: {"questions":[{"ask":"Compare against what?","multi":false,"options":["The previous year","Other regions","Other genres"]},{"ask":"Which measures should it show?","multi":true,"options":["Total sales","Number of transactions","Year-on-year change"]}]}\n` +
        `Draw the options from what actually exists in the schema, and word ` +
        `them in plain business language — never expose raw measure or column ` +
        `syntax like [1_ Total Interactions] or 'Table'[Column].\n` +
        `Do not ask when a sensible reading is obvious: a question naming one ` +
        `measure, or one that clearly means the whole dataset, should just be ` +
        `answered. Earlier turns in the conversation count as context — if they ` +
        `already establish the measure or period, use it rather than asking ` +
        `again.\n` +
        `Never ask twice. If the question already carries the specifics — ` +
        `typically after an em dash, e.g. "compare the categories — year over ` +
        `year, by ticket volume" — those ARE the answers to a question you ` +
        `already asked. Write the query.\n\n`) +
    `Dataset schema:\n${schemaDescription}`
  );
}

// Shared by the data path and by escalation from the visual path, so both get
// the same rules, schema grounding and CORE_RULES.
async function generateDaxFor(report, provider, messages, opts = {}) {
  const raw = stripCodeFence(
    await provider.complete({
      system: buildDaxSystemPrompt(report, opts),
      messages,
      // Reasoning models spend completion tokens thinking before emitting
      // anything; this is a ceiling, not a target.
      maxTokens: 5000,
    })
  );

  // A clarifying question isn't a query, so it must not be rewritten.
  if (findClarify(raw)) return raw;

  // Repair the SUMMARIZECOLUMNS shapes the model keeps getting wrong even when
  // shown the engine's own error. Each has one correct rewrite, so fixing them
  // here saves a failed round trip to Power BI — see lib/daxLint.js.
  const { dax, notes } = lintDax(raw);
  if (notes.length) console.error("[dax lint]", notes.join("; "));
  return dax;
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
        `- If the question needs figures that are NOT on this page — a prior ` +
        `period, a different slice, anything the visuals don't show — do not ` +
        `tell the user to go and build a view. Instead make your ENTIRE reply ` +
        `a single line, nothing before or after it:\n` +
        `NEED_DATA: <plainly what you need, naming the entities on screen it ` +
        `relates to>\n` +
        `For example: NEED_DATA: 2015 sales for these same five games — Fifa ` +
        `17, Tom Clancy's Rainbow Six Siege, Uncharted 4, Far Cry Primal, ` +
        `Overwatch. The underlying model will be queried and you'll be asked ` +
        `again with the results. Only do this when the page genuinely lacks ` +
        `the figures — if it has them, just answer.\n` +
        `- If the question itself is ambiguous — a comparison that doesn't say ` +
        `what to compare against, on which measure, or over which period, or ` +
        `a request to build something ("give me a chart") that doesn't say ` +
        `what to plot — don't guess and don't refuse. Ask.\n` +
        `Write ONE short sentence saying what you need to pin down (never an ` +
        `apology, never "I can't"), then on its own final line:\n` +
        `CLARIFY: {"questions":[{"ask":"<short question>","multi":false,"options":["<option>","<option>"]}]}\n` +
        `Ask each open axis separately, at most 3 questions with 2-6 options ` +
        `each, worded in plain business language. Draw the options from what ` +
        `is actually on this page — the real measures, fields and slicer ` +
        `values you can see — so every option is one you could deliver.\n` +
        `Set "multi":true where several answers make sense together (which ` +
        `measures to include, which categories to cover) and false where only ` +
        `one can apply (which axis, which single period). The user ticks the ` +
        `options, so this decides whether more than one may be ticked.\n` +
        `Prefer answering outright when a sensible reading is obvious.\n` +
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
        // Hold the head of the stream back until we know whether this is an
        // answer, a request for data, or a question back to the user. Both
        // markers must be the first line, so a short buffer is enough to tell —
        // and nothing is shown either way until we know, so neither case ever
        // flashes partial text.
        const MARKER = /^\s*(NEED_DATA|CLARIFY):/i;
        let head = "";
        let held = false;
        let forwarding = false;

        // Everything received, and how much of it has been forwarded. The two
        // differ because the trailing FOLLOW_UPS line is held back.
        let acc = "";
        let sent = 0;
        const flush = () => {
          const safe = emitSafe(acc);
          if (safe.length > sent) {
            send({ delta: safe.slice(sent) });
            sent = safe.length;
          }
        };

        const answer = await provider.completeStream(request, (delta) => {
          acc += delta;
          if (forwarding) return flush();
          head += delta;
          if (MARKER.test(head)) {
            held = true;
            return;
          }
          // Once there's enough to rule the markers out, release the buffer.
          if (held) return;
          if (head.length >= 24 || /\n/.test(head)) {
            forwarding = true;
            flush();
          }
        });

        // Ambiguous question — ask rather than guess or fetch the wrong thing.
        // The marker is looked for anywhere, not just on the first line: a
        // reply that opens with a sentence and then asks properly is still a
        // question, and used to reach the user as raw JSON.
        const clarifyAt = findClarify(answer);
        if (clarifyAt) {
          const questions = parseClarify(clarifyAt.payload);
          return (
            send({
              done: true,
              // Anything the model said before the marker is its reasoning for
              // asking, which is exactly the framing a good analyst gives.
              answer:
                clarifyAt.lead ||
                (questions.length > 1
                  ? "A couple of things would change the answer:"
                  : questions[0].ask),
              questions,
              clarify: true,
              visualContext,
            }),
            res.end()
          );
        }

        if (!/^\s*NEED_DATA:/i.test(answer)) {
          const split = splitFollowUps(answer);
          if (!forwarding) send({ delta: split.answer }); // shorter than the buffer
          return (
            send({
              done: true,
              answer: split.answer,
              followUps: split.followUps,
              visualContext,
            }),
            res.end()
          );
        }

        // --- escalation: the page can't answer it, so query the model -------
        const needed = answer.replace(/^\s*NEED_DATA:\s*/i, "").trim();
        send({ stage: "querying" });

        const entities = entitiesOnScreen(state);
        const filterSummary = describeFilters([
          ...(state?.reportFilters || []),
          ...(state?.pageFilters || []),
        ]);

        const grounding =
          `The user is looking at a report page and asked a question the page ` +
          `cannot answer on its own. Write a DAX query for the missing data.\n\n` +
          `What is needed: ${needed}\n` +
          `Filters currently applied on their view: ${filterSummary}\n` +
          (entities
            ? `The question refers to these specific ${entities.header || "items"} ` +
              `currently shown in "${entities.visualTitle}" — return rows for ` +
              `THESE, not a fresh top-N:\n${entities.values.map((v) => `- ${v}`).join("\n")}\n`
            : "") +
          `\nCritical:\n` +
          `- Apply the time period or slice named in "what is needed" as an ` +
          `actual filter in the query. Naming a column "2015 Sales" while ` +
          `filtering nothing returns the wrong figures and is worse than ` +
          `failing outright.\n` +
          `- The view's current filter is context for identifying the items. ` +
          `Do not reapply it if the request asks for a different period.\n` +
          `- Return one row per item listed above so the results line up with ` +
          `what is on screen.\n\n` +
          `Return only the DAX query.`;

        let rows = null;
        let queryError = null;
        let usedDax = null;
        try {
          usedDax = await generateDaxFor(
            report,
            provider,
            [{ role: "user", content: grounding }],
            { allowClarify: false }
          );
          const credentials = {
            tenantId: settings.pbiTenantId,
            clientId: settings.pbiClientId,
            clientSecret: settings.pbiClientSecret,
          };
          const target = { workspaceId: report.workspaceId, datasetId: report.datasetId };

          try {
            rows = await executeQuery(credentials, { ...target, dax: usedDax });
          } catch (firstErr) {
            // Same self-correction the data path gets: most failures here are
            // mechanical (argument order, quoting) and the model fixes them
            // once it can see what the engine said.
            console.error("[escalation] first attempt failed:", firstErr.message);
            usedDax = await generateDaxFor(
              report,
              provider,
              [
                { role: "user", content: grounding },
                { role: "assistant", content: usedDax },
                {
                  role: "user",
                  content:
                    `Power BI rejected that query:\n\n${firstErr.message}\n\n` +
                    `Return a corrected DAX query, keeping the same filters and ` +
                    `the same list of items. Return ONLY the query.`,
                },
              ],
              { allowClarify: false }
            );
            rows = await executeQuery(credentials, { ...target, dax: usedDax });
          }
        } catch (err) {
          queryError = err.message;
          // Worth a server-side line: the user only sees "couldn't retrieve
          // it", which isn't enough to diagnose a recurring failure.
          console.error("[escalation] query failed:", err.message);
          if (usedDax) console.error("[escalation] dax was:", usedDax.replace(/\s+/g, " ").slice(0, 300));
        }

        let composedAcc = "";
        let composedSent = 0;
        const composed = await provider.completeStream(
          {
            system:
              problemContext(report) +
              `You are a data analyst. The user asked a question about the ` +
              `report page in front of them. The page alone could not answer ` +
              `it, so the underlying model was queried for the missing part.\n\n` +
              `Answer their question using both sources, and make clear which ` +
              `is which — say "on screen" for figures from their current view ` +
              `and "from the model" (or similar plain wording) for the queried ` +
              `figures. Lead with the finding. Never state a number that is ` +
              `not in one of the two sources.\n` +
              (queryError
                ? `The query FAILED. Answer from the screen alone and say ` +
                  `plainly that you could not retrieve the rest — do not ` +
                  `invent it.\n`
                : "") +
              `Keep it under 110 words. Prose only, no JSON, no DAX.\n\n` +
              FOLLOW_UP_RULE +
              `What was missing: ${needed}\n\n` +
              `Their current view:\n${stateText}\n\n` +
              (queryError
                ? `Query error: ${queryError}`
                : `Rows returned from the model:\n${JSON.stringify(rows || []).slice(0, MAX_RESULT_CHARS)}`),
            messages: [...priorTurns, { role: "user", content: question }],
            maxTokens: 5000,
          },
          (delta) => {
            composedAcc += delta;
            const safe = emitSafe(composedAcc);
            if (safe.length > composedSent) {
              send({ delta: safe.slice(composedSent) });
              composedSent = safe.length;
            }
          }
        );

        const composedSplit = splitFollowUps(composed);
        send({
          done: true,
          answer: composedSplit.answer,
          followUps: composedSplit.followUps,
          visualContext: { ...visualContext, queried: true },
        });
      } catch (err) {
        send({ error: `Visual analysis failed: ${err.message}` });
      }
      return res.end();
    }

    // Providers without streaming (currently Anthropic and Gemini) land here.
    // They get the same system prompt, so they emit the same markers, and must
    // therefore get the same handling — otherwise a clarifying question reaches
    // the user as raw JSON purely because of which model is configured.
    const raw = await provider.complete(request);

    const clarifyPlain = findClarify(raw);
    if (clarifyPlain) {
      const questions = parseClarify(clarifyPlain.payload);
      return res.json({
        answer:
          clarifyPlain.lead ||
          (questions.length > 1
            ? "A couple of things would change the answer:"
            : questions[0].ask),
        questions,
        chart: null,
        clarify: true,
        visualContext,
      });
    }

    // Escalation needs the streaming plumbing, so on these providers the
    // request is answered from the screen instead — but the marker itself must
    // never be shown.
    if (/^\s*NEED_DATA:/i.test(raw)) {
      return res.json({
        answer:
          `That needs figures this page doesn't show, and I can't query the ` +
          `model on the currently configured provider. Switching to an ` +
          `OpenAI-compatible model enables it.`,
        chart: null,
        visualContext,
      });
    }

    const plain = splitFollowUps(raw);
    res.json({
      answer: plain.answer,
      chart: null,
      followUps: plain.followUps,
      visualContext,
    });
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
  let rowsForPrompt = JSON.stringify(rows.slice(0, MAX_RESULT_ROWS));
  if (rowsForPrompt.length > MAX_RESULT_CHARS) {
    rowsForPrompt = rowsForPrompt.slice(0, MAX_RESULT_CHARS);
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
