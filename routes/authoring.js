// Authoring path: helping the user build or fix something in Power BI, rather
// than answering a question about their data.
//
// Any DAX this proposes is executed against the live model before it's
// returned, so the user is told whether it actually runs — the difference
// between a suggestion and something they can paste with confidence.

const express = require("express");
const { getSettings, getReport } = require("../lib/settings");
const { getProvider } = require("../lib/llm");
const { executeQuery } = require("../lib/powerbi");
const { CORE_RULES, PATTERNS } = require("../lib/daxSkills");
const { problemContext, sanitizeHistory, stripCodeFence } = require("../lib/chatHelpers");

const router = express.Router();

// Models habitually write "Measure Name = <expression>" even when asked for
// the expression alone. DEFINE MEASURE supplies its own name, so the extra one
// is a syntax error — strip it rather than depend on the model complying.
// The lookaheads keep a genuine "VAR x =" from being mistaken for a name.
function stripMeasureName(expression) {
  return expression
    .replace(/^(?!\s*VAR\b)(?!\s*RETURN\b)\s*[A-Za-z0-9_%\s]+?=\s*/, "")
    .trim();
}

// DAX rejects a VAR named after one of its keywords, and the model keeps
// reaching for "Current" however firmly the prompt says not to. Rename them
// deterministically instead of relying on compliance — and rename in the code
// the user is shown, so what they paste is what was validated.
const RESERVED_VAR_NAMES = new Set(
  [
    "current", "date", "value", "filter", "order", "rank", "min", "max", "sum",
    "average", "count", "year", "month", "day", "time", "table", "column",
    "row", "not", "and", "or", "in", "var", "return", "define", "measure",
    "evaluate", "true", "false", "blank",
  ]
);

function renameReservedVars(expression) {
  const names = new Set();
  for (const m of expression.matchAll(/\bVAR\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (RESERVED_VAR_NAMES.has(m[1].toLowerCase())) names.add(m[1]);
  }
  let out = expression;
  for (const name of names) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), `${name}Val`);
  }
  return out;
}

// A measure definition isn't runnable on its own. DEFINE MEASURE plus a
// one-row EVALUATE makes it executable without altering the model.
function wrapMeasureForTest(table, expression) {
  return (
    `DEFINE MEASURE '${table}'[__SkillCheck] = ${stripMeasureName(expression)}\n` +
    `EVALUATE ROW("Result", [__SkillCheck])`
  );
}

router.post("/", async (req, res) => {
  const { reportId, question } = req.body || {};
  const priorTurns = sanitizeHistory(req.body && req.body.history);

  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(reportId);
  } catch (err) {
    return res.status(503).json({ error: `Settings database unavailable: ${err.message}` });
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

  try {
    const raw = await provider.complete({
      system:
        problemContext(report) +
        `You are a Power BI consultant helping someone build or fix something ` +
        `in their own report. Respond with ONLY a JSON object:\n` +
        `{"answer": "<explanation as markdown>", "dax": "<the measure or query, or null>", "testTable": "<table to define a test measure on, or null>", "followUps": ["<question>", "<question>", "<question>"]}\n\n` +
        `Put code in "dax", never inside the answer text — it is rendered ` +
        `separately. For a measure give the expression only (no "Name = " ` +
        `prefix), and name the fact table in "testTable" so it can be checked ` +
        `against the model. Use null for both on a conceptual question that ` +
        `needs no code.\n\n` +
        `Explain briefly why the approach works and flag the trade-off that ` +
        `matters — performance, measure vs calculated column, or filter ` +
        `context. Keep the explanation under 120 words. Use their real tables, ` +
        `columns and measures, spelled exactly; never invent names.\n\n` +
        `"followUps" are three questions this naturally leads to — extending ` +
        `the measure, a variant, a related problem — each under nine words.\n\n` +
        PATTERNS +
        `\n\n` +
        CORE_RULES +
        `\n\nTheir model:\n${report.schemaDescription || "(not described)"}`,
      messages: [...priorTurns, { role: "user", content: question }],
      json: true,
      maxTokens: 5000,
    });

    let parsed;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      // Model ignored the JSON contract — still better to show its prose than
      // to fail the question outright.
      return res.json({ answer: raw.trim(), chart: null, authoring: true });
    }

    const result = {
      answer: parsed.answer || "",
      followUps: Array.isArray(parsed.followUps) ? parsed.followUps.slice(0, 3) : [],
      dax: parsed.dax ? renameReservedVars(parsed.dax) : null,
      chart: null,
      authoring: true,
    };

    if (parsed.dax && report.datasetId) {
      const credentials = {
        tenantId: settings.pbiTenantId,
        clientId: settings.pbiClientId,
        clientSecret: settings.pbiClientSecret,
      };
      // Validate exactly what the user is shown (result.dax), not the model's
      // raw output — otherwise the badge could pass for code they don't have.
      const alreadyAQuery = /^\s*(DEFINE|EVALUATE)/i.test(result.dax);
      const dax = alreadyAQuery
        ? result.dax
        : wrapMeasureForTest(parsed.testTable || "DataTable", result.dax);

      try {
        const rows = await executeQuery(credentials, {
          workspaceId: report.workspaceId,
          datasetId: report.datasetId,
          dax,
        });
        const first = rows && rows[0] ? Object.values(rows[0])[0] : null;
        result.validation = {
          ok: true,
          sample: first === null || first === undefined ? null : String(first),
        };
      } catch (err) {
        result.validation = { ok: false, error: err.message.slice(0, 300) };
      }
    }

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Authoring help failed: ${err.message}` });
  }
});

module.exports = router;
