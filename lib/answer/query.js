// lib/answer/query.js
//
// The data path: question -> DAX -> query against the model -> a written
// answer, with the chart built from the rows that came back.

const { executeQuery } = require("../powerbi");
const { buildChartSpec, validTypesFor } = require("../chartChoice");
const { groundingIssues } = require("../daxLint");
const llmCache = require("../llmCache");
const {
  problemContext,
  stripCodeFence,
  parseClarify,
  findClarify,
} = require("../chatHelpers");
const BUDGETS = require("../budgets");
const { buildDaxSystemPrompt } = require("./dax");

async function run(ctx, emit) {
  const { report, settings, provider, question } = ctx;
  const priorTurns = ctx.history || [];

  // Only reuse a cached answer for a standalone question. Once there are
  // prior turns, the same words can mean something different ("and 2022?"),
  // so a cache keyed on the question alone would return the wrong answer.
  const cached = priorTurns.length === 0 ? llmCache.get(report.id, question) : null;
  if (cached) {
    // Emitted as a stream even though nothing was generated, so the SSE
    // contract holds whether or not the cache was hit.
    emit({ delta: cached.answer });
    return { ...cached, cached: true };
  }

  const pbiCredentials = {
    tenantId: settings.pbiTenantId,
    clientId: settings.pbiClientId,
    clientSecret: settings.pbiClientSecret,
  };

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

  emit({ stage: "writing_query" });

  // A generation failure throws: the front door maps it centrally.
  if (ctx.aborted()) throw new Error("cancelled");
  let dax = await generateDax([...priorTurns, { role: "user", content: question }]);

  // The model can decline to guess when the question doesn't pin down a
  // measure, filter or period. Return the question it asked instead of
  // querying — a wrong number presented confidently is worse than a
  // one-line clarification.
  const clarifyInDax = findClarify(dax);
  if (clarifyInDax) {
    const questions = parseClarify(clarifyInDax.payload);
    return {
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
    };
  }

  // A query can be perfectly valid and still answer a different question —
  // "top 10 genres in 2016" returning all-time totals runs fine and reads as
  // an answer. The engine will never complain, so check before running it.
  // Above the try, not inside it: the catch below swallows by design, so a
  // cancel raised in there would be logged as a failed correction and the
  // pipeline would go on to run the Power BI query anyway.
  if (ctx.aborted()) throw new Error("cancelled");
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
  emit({ stage: "running_query" });
  let rows;
  try {
    if (ctx.aborted()) throw new Error("cancelled");
    rows = await executeQuery(pbiCredentials, {
      workspaceId: report.workspaceId,
      datasetId: report.datasetId,
      dax,
    });
  } catch (firstErr) {
    const firstDax = dax;
    emit({ stage: "retrying_query" });
    try {
      if (ctx.aborted()) throw new Error("cancelled");
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
      if (ctx.aborted()) throw new Error("cancelled");
      rows = await executeQuery(pbiCredentials, {
        workspaceId: report.workspaceId,
        datasetId: report.datasetId,
        dax,
      });
    } catch (retryErr) {
      // The query goes with the error so the mapper can surface what ran.
      retryErr.dax = dax;
      throw retryErr;
    }
  }

  const rowCount = rows.length;
  const dropped = Math.max(0, rowCount - BUDGETS.RESULT_ROWS);
  let rowsForPrompt = JSON.stringify(rows.slice(0, BUDGETS.RESULT_ROWS));
  if (rowsForPrompt.length > BUDGETS.RESULT_CHARS) {
    rowsForPrompt = rowsForPrompt.slice(0, BUDGETS.RESULT_CHARS);
  }

  emit({ stage: "composing" });

  let answer = "";
  let chart = null;
  let followUps = [];
  // Above the try: the catch below turns any throw into fallback answer text,
  // which would resolve the run normally and then cache "LLM answer generation
  // failed: cancelled" against a standalone question — serving that to the
  // next person who asks it.
  if (ctx.aborted()) throw new Error("cancelled");
  try {
    const raw = await provider.complete({
      system:
        problemContext(report) +
        `You are a data analyst presenting findings to a business audience. ` +
        `You are given a question and the raw result rows (JSON) from a Power ` +
        `BI query. Respond with ONLY a JSON object of the form:\n` +
        `{"answer": "<your analysis, as markdown>", "intent": "share"|"change"|"trend"|"ranking"|"single"|null, "followUps": ["<question>", "<question>", "<question>"]}\n\n` +
        `"intent" is what the question is ABOUT, which decides how the figures ` +
        `are drawn — a share of a whole, a change between two things, a ` +
        `movement over time, an ordering of categories, or a single headline ` +
        `number. The chart itself is built from the rows, not by you; this is ` +
        `the one thing about it only you can know. Use null if none fits.\n\n` +
        `"followUps" are three questions this answer naturally leads to, each ` +
        `answerable from this same report and under nine words. Prefer ones ` +
        `that go somewhere new — a breakdown, a comparison, a cause — rather ` +
        `than a restatement of what you just said. Always include them.\n\n` +
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
        `Never state a number that is not present in the rows.`,
      messages: [
        {
          role: "user",
          // The DAX matters here: with conversation history a question can be
          // as bare as "and 2023?", and without seeing the query the model
          // can't tell what period or filter the rows actually represent.
          content:
            `Question: ${question}\n\n` +
            `Query that produced these rows:\n${dax}\n\n` +
            `Result rows (JSON): ${rowsForPrompt}` +
            // Silently handing over a slice used to produce answers that read
            // as the whole result.
            (dropped
              ? `\n\nNote: the query returned ${rowCount.toLocaleString()} rows and you ` +
                `are seeing the first ${BUDGETS.RESULT_ROWS.toLocaleString()}. Say so in your ` +
                `answer rather than presenting these as the whole result.`
              : ""),
        },
      ],
      json: true,
      // Room for a short answer plus the follow-ups, with headroom for
      // reasoning models (see the note on the DAX call above).
      maxTokens: 5000,
    });

    const parsed = JSON.parse(stripCodeFence(raw));
    answer = parsed.answer ?? "";
    followUps = Array.isArray(parsed.followUps) ? parsed.followUps.slice(0, 3) : [];
    // One producer. The model contributes intent; the rows decide everything
    // else, because mapping rows to labels and values is mechanical and there
    // is nothing for a model to get wrong about it.
    chart = buildChartSpec(ctx.question, rows, { intent: parsed.intent });
    // The browser can't classify the rows itself -- it never sees them -- so
    // the switcher's options are decided here, where they are already known.
    if (chart) chart.validTypes = validTypesFor(rows);
  } catch (err) {
    // Fall back to raw text rather than 500ing — the DAX + rows already
    // succeeded, so surface something useful.
    answer = err instanceof SyntaxError
      ? "The model's answer couldn't be parsed as JSON; showing the generated DAX and row count instead."
      : `LLM answer generation failed: ${err.message}`;
  }

  emit({ delta: answer });

  const result = { answer, chart, dax, rowCount, followUps };
  if (priorTurns.length === 0) llmCache.set(report.id, question, result);
  return result;
}

module.exports = { run };
