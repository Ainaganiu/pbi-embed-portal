// lib/answer/state.js

const BUDGETS = require("../budgets");
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

function entitiesOnScreen(state, focusVisualName) {
  const visuals = state?.visuals || [];
  // Prefer the visual the question was about; otherwise the first one with a
  // categorical first column.
  const candidates = [...visuals].sort(
    (a, b) => (b.name === focusVisualName ? 1 : 0) - (a.name === focusVisualName ? 1 : 0)
  );

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

function renderReportState(state, focusVisualName) {
  const lines = [];
  lines.push(`Active page: ${state.pageName || "(unknown)"}`);
  lines.push(`Report-level filters: ${describeFilters(state.reportFilters)}`);
  lines.push(`Page-level filters: ${describeFilters(state.pageFilters)}`);

  const all = state.visuals || [];
  const isFocus = (v) => Boolean(focusVisualName) && v.name === focusVisualName;
  const visuals = all.slice(0, BUDGETS.VISUALS_IN_PROMPT);
  lines.push(`\nVisuals currently on this page (${all.length}):`);

  visuals.forEach((v, i) => {
    const focusTag = isFocus(v) ? "   <-- THE VISUAL THE QUESTION IS ABOUT" : "";
    lines.push(`\n${i + 1}. "${v.title || "(untitled)"}" — ${v.type || "unknown type"}${focusTag}`);
    if (v.slicerState) lines.push(`   slicer selection: ${v.slicerState}`);
    if (v.visualFilters) lines.push(`   filters on this visual: ${describeFilters(v.visualFilters)}`);
    if (v.error) lines.push(`   (data unavailable: ${v.error})`);
    else if (v.data) {
      const cap = isFocus(v) ? BUDGETS.CHARS_FOCUSED_VISUAL : BUDGETS.CHARS_PER_VISUAL;
      lines.push(`   data:\n${String(v.data).slice(0, cap)}`);
    }
  });

  if (all.length > BUDGETS.VISUALS_IN_PROMPT) {
    lines.push(`\n(${all.length - BUDGETS.VISUALS_IN_PROMPT} further visuals omitted.)`);
  }
  return lines.join("\n").slice(0, BUDGETS.STATE_CHARS);
}

function visualContextFrom(state, focusVisualName) {
  const focused = (state?.visuals || []).find((v) => v && v.name === focusVisualName);
  return {
    pageName: state?.pageName || null,
    visualCount: (state?.visuals || []).length,
    focusTitle: focused ? focused.title : null,
    // Report- and page-level filters both narrow what's on screen, so the
    // "what was read" line has to account for both.
    filters: describeFilters([...(state?.reportFilters || []), ...(state?.pageFilters || [])]),
  };
}

module.exports = { describeFilters, entitiesOnScreen, renderReportState, visualContextFrom };
