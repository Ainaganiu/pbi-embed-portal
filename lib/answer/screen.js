// lib/answer/screen.js
//
// Answering from what the user currently has on screen, escalating to a query
// against the model when the page alone cannot answer the question.

const { executeQuery } = require("../powerbi");
const { buildChartSpec, validTypesFor } = require("../chartChoice");
const { groundingIssues } = require("../daxLint");
const {
  problemContext,
  schemaContext,
  GROUNDING_RULE,
  parseClarify,
  findClarify,
  findNeedData,
  confirmsPreviousTurn,
  refersToScreenEntities,
  splitChart,
  FOLLOW_UP_RULE,
  splitFollowUps,
  emitSafe,
} = require("../chatHelpers");
const BUDGETS = require("../budgets");
const {
  describeFilters,
  entitiesOnScreen,
  renderReportState,
  visualContextFrom,
} = require("./state");
const { generateDaxFor } = require("./dax");

async function run(ctx, emit) {
  const { report, settings, provider, question, state } = ctx;
  const priorTurns = ctx.history || [];

  emit({ stage: "reading" });

  const stateText = renderReportState(state || {}, ctx.focusVisual);
  const visualContext = visualContextFrom(state, ctx.focusVisual);

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
      `period, a different slice, anything the visuals don't show — you can ` +
      `go and get them. Never tell the user you can't, never tell them to ` +
      `build a view: the query IS your answer, so write as someone about to ` +
      `run it, not someone declining. At most one short sentence saying ` +
      `what the page does show and why it falls short, then on its own ` +
      `final line:\n` +
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
      // Screen-only answers are the common case, so without this the
      // follow-up chips never appear on most replies.
      FOLLOW_UP_RULE +
      `(Skip that line entirely if you are emitting NEED_DATA or CLARIFY — ` +
      `those are requests, not answers.)\n\n` +
      GROUNDING_RULE +
      `\nBackground on the underlying model (for context only; the current ` +
      `view above is what the user is asking about):\n` +
      `${schemaContext(report).slice(0, 2500)}`,
    messages: [
      ...priorTurns,
      { role: "user", content: `Current report state:\n${stateText}\n\nQuestion: ${question}` },
    ],
    maxTokens: BUDGETS.MAX_TOKENS_ANALYSIS,
  };

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
      emit({ delta: safe.slice(sent) });
      sent = safe.length;
    }
  };

  // "it's not on the page" adds no new question — it agrees with what
  // the last turn already worked out. Re-running the analysis returns
  // the same reply, which is the loop this avoids: go straight to
  // fetching what that turn said it needed.
  const confirmed = confirmsPreviousTurn(question, priorTurns);

  const readScreen = () =>
    provider.completeStream(request, (delta) => {
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

  if (ctx.aborted()) throw new Error("cancelled");
  const answer = confirmed ? `NEED_DATA: ${confirmed}` : await readScreen();

  // Ambiguous question — ask rather than guess or fetch the wrong thing.
  // The marker is looked for anywhere, not just on the first line: a
  // reply that opens with a sentence and then asks properly is still a
  // question, and used to reach the user as raw JSON.
  const clarifyAt = findClarify(answer);
  if (clarifyAt) {
    const questions = parseClarify(clarifyAt.payload);
    return {
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
    };
  }

  // Found anywhere, not just on the first line. The model habitually
  // explains what the page does and doesn't show before asking for the
  // data, and under first-line-only detection that whole reply fell
  // through as prose — so the user was shown the raw marker and the
  // query it asked for never ran.
  const needData = findNeedData(answer);
  if (!needData) {
    const split = splitFollowUps(answer);
    if (!forwarding) emit({ delta: split.answer }); // shorter than the buffer
    return {
      answer: split.answer,
      followUps: split.followUps,
      visualContext,
    };
  }

  // --- escalation: the page can't answer it, so query the model -------
  const needed = needData.payload.trim();
  emit({ stage: "escalating" });

  const entities = entitiesOnScreen(state, ctx.focusVisual);
  const filterSummary = describeFilters([
    ...(state?.reportFilters || []),
    ...(state?.pageFilters || []),
  ]);

  const grounding =
    `The user is looking at a report page and asked a question the page ` +
    `cannot answer on its own. Write a DAX query for the missing data.\n\n` +
    `What is needed: ${needed}\n` +
    `Filters currently applied on their view: ${filterSummary}\n` +
    // Only when the question actually points back at the screen. Asked
    // for "top 10 genres in 2016", constraining to the five on screen
    // returned exactly those five and then explained it couldn't find
    // ten — the same mistake as an unconstrained query, in reverse.
    (entities && refersToScreenEntities(question)
      ? `The question refers to these specific ${entities.header || "items"} ` +
        `currently shown in "${entities.visualTitle}" — return rows for ` +
        `THESE, not a fresh top-N:\n${entities.values.map((v) => `- ${v}`).join("\n")}\n`
      : entities
        ? `For context, "${entities.visualTitle}" currently shows: ` +
          `${entities.values.slice(0, 8).join(", ")}. The question asks ` +
          `for its own set, so do NOT constrain the query to these.\n`
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
    if (ctx.aborted()) throw new Error("cancelled");
    usedDax = await generateDaxFor(
      report,
      provider,
      [{ role: "user", content: grounding }],
      { allowClarify: false, reasoning: "low" }
    );

    // Same check the data path runs before its first execute: a query that
    // runs but returns raw, ungrouped rows for a breakdown question reads
    // as an answer and never trips the Power BI retry below. The abort
    // check sits above this try, not inside it -- the catch below is a
    // deliberate swallow (a failed correction shouldn't lose the first
    // query), and a cancel raised inside it would be logged as exactly
    // that instead of propagating.
    if (ctx.aborted()) throw new Error("cancelled");
    try {
      const issues = groundingIssues(question, usedDax);
      if (issues.length) {
        console.error("[escalation grounding]", issues.join("; "));
        usedDax = await generateDaxFor(
          report,
          provider,
          [
            { role: "user", content: grounding },
            { role: "assistant", content: usedDax },
            {
              role: "user",
              content:
                `That query does not answer the question: ${issues.join("; ")}.\n\n` +
                `Return ONLY the corrected query.`,
            },
          ],
          { allowClarify: false, reasoning: "low" }
        );
      }
    } catch (err) {
      // The first query is still runnable; a failed correction shouldn't
      // lose it.
      console.error("[escalation grounding] correction failed:", err.message);
    }

    const credentials = {
      tenantId: settings.pbiTenantId,
      clientId: settings.pbiClientId,
      clientSecret: settings.pbiClientSecret,
    };
    const target = { workspaceId: report.workspaceId, datasetId: report.datasetId };

    emit({ stage: "running_query" });
    try {
      if (ctx.aborted()) throw new Error("cancelled");
      rows = await executeQuery(credentials, { ...target, dax: usedDax });
    } catch (firstErr) {
      // Same self-correction the data path gets: most failures here are
      // mechanical (argument order, quoting) and the model fixes them
      // once it can see what the engine said.
      console.error("[escalation] first attempt failed:", firstErr.message);
      console.error("[escalation] rejected dax:", usedDax.replace(/\s+/g, " ").slice(0, 400));
      emit({ stage: "retrying_query" });
      if (ctx.aborted()) throw new Error("cancelled");
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
        { allowClarify: false, reasoning: "low" }
      );
      if (ctx.aborted()) throw new Error("cancelled");
      rows = await executeQuery(credentials, { ...target, dax: usedDax });
    }
  } catch (err) {
    queryError = err.message;
    // Worth a server-side line: the user only sees "couldn't retrieve
    // it", which isn't enough to diagnose a recurring failure.
    console.error("[escalation] query failed:", err.message);
    if (usedDax) console.error("[escalation] dax was:", usedDax.replace(/\s+/g, " ").slice(0, 300));
  }

  // The rows are in hand, so the chart is built from them directly —
  // type chosen the same way the data path chooses it, labels and values
  // read straight off the result. Nothing here needs a model.
  const chartSpec = queryError ? null : buildChartSpec(question, rows || []);
  // Same reasoning as the data path: the browser never sees these rows, so
  // the switcher's options have to be decided here.
  if (chartSpec) chartSpec.validTypes = validTypesFor(rows || []);

  let composedAcc = "";
  let composedSent = 0;
  if (ctx.aborted()) throw new Error("cancelled");
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
        `Keep it under 110 words. Prose first — no JSON and no DAX in ` +
        `the prose itself.\n\n` +
        // The rows were fetched precisely because the screen couldn't
        // show them, so there is no visual of them anywhere. Drawing
        // them here is the only way the user sees the shape of what was
        // retrieved rather than a list of numbers in a sentence.
        // The chart is built from the rows in code, not asked for here.
        // Asked for it alongside the follow-ups, the model emitted one
        // trailing line or the other and dropped whichever came first —
        // about two replies in six carried a chart, however the
        // instruction was worded. See buildChartSpec.
        (chartSpec
          ? `A ${chartSpec.type} chart of these rows is shown beneath ` +
            `your answer, so don't describe the shape of the data or ` +
            `list every row — give the finding and the figures that ` +
            `matter.\n\n`
          : "") +
        FOLLOW_UP_RULE +
        GROUNDING_RULE +
        `\nWhat the underlying model actually contains, for reference:\n` +
        `${schemaContext(report).slice(0, 2500)}\n\n` +
        `What was missing: ${needed}\n\n` +
        `Their current view:\n${stateText}\n\n` +
        (queryError
          ? `Query error: ${queryError}`
          : // Without the query itself the model hedges about its own
            // rows — "these also aren't explicitly filtered to 2016 in
            // what I received" — which reads as a non-answer even when
            // the filter is right there. Show it the query so it can
            // see what it is holding.
            `This query ran successfully against the model, so its rows ` +
            `ARE the slice that was asked for — state them as fact, and ` +
            `do not speculate about whether the filter was applied:\n` +
            `${usedDax}\n\n` +
            `Rows it returned:\n${JSON.stringify(rows || []).slice(0, BUDGETS.RESULT_CHARS)}`),
      messages: [...priorTurns, { role: "user", content: question }],
      maxTokens: BUDGETS.MAX_TOKENS_ANALYSIS,
      // Reconciling screen figures against queried ones is the one
      // place here where thinking earns its seconds.
      reasoning: "low",
    },
    (delta) => {
      composedAcc += delta;
      const safe = emitSafe(composedAcc);
      if (safe.length > composedSent) {
        emit({ delta: safe.slice(composedSent) });
        composedSent = safe.length;
      }
    }
  );

  const composedSplit = splitFollowUps(composed);
  // splitChart still runs: a model that emits the line unprompted would
  // otherwise leave it sitting in the prose. Its chart is discarded, not used
  // as a fallback -- charts are built in code, never by the model, and a spec
  // the model invented is exactly what that rule exists to keep off screen.
  const composedChart = splitChart(composedSplit.answer);

  return {
    answer: composedChart.answer,
    chart: chartSpec,
    followUps: composedSplit.followUps,
    visualContext: { ...visualContext, queried: true },
  };
}

module.exports = { run };
