// lib/modelCard.js
//
// The model knows its structure and nothing about what any of it means; the
// admin knows the meaning and has no guarantee the names they typed still
// exist. This joins the two and, just as importantly, reports where they
// disagree -- a description naming a measure that was renamed goes on
// teaching the model to write DAX against something that is not there.

const BUDGETS = require("./budgets");

// Below this length a bare word is too generic to attach prose to: a column
// called "ID" would otherwise claim every sentence mentioning an id.
const MIN_BARE_NAME = 4;

// [Name], 'Table'[Name] or Table[Name] -- the forms someone writing about a
// model actually uses.
const BRACKETED = /(?:'([^']+)'|(\w+))?\[([^\]]+)\]/g;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function descriptionLines(report) {
  return [report.schemaDescription, report.measuresDescription, report.columnsDescription]
    .filter(Boolean)
    .join("\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function mentions(line, name) {
  const escaped = escapeRegExp(name);
  if (new RegExp(`\\[\\s*${escaped}\\s*\\]`, "i").test(line)) return true;
  if (name.length < MIN_BARE_NAME) return false;
  return new RegExp(`\\b${escaped}\\b`, "i").test(line);
}

function reconcile(metadata, report) {
  const lines = descriptionLines(report || {});
  const objects = [
    ...(metadata?.measures || []).map((m) => ({ kind: "measure", name: m.name, table: m.table })),
    ...(metadata?.columns || []).map((c) => ({ kind: "column", name: c.name, table: c.table })),
  ];

  const described = [];
  const undescribed = [];
  const claimed = new Set();

  for (const obj of objects) {
    const hits = lines.filter((line) => mentions(line, obj.name));
    if (hits.length) {
      hits.forEach((h) => claimed.add(h));
      described.push({ ...obj, lines: hits });
    } else {
      undescribed.push(obj);
    }
  }

  // A bracketed token matching no real object is the drift this exists to
  // catch. Table names count as real: "'DataTable'[Interaction Type]" names
  // both, and only the column part needs to resolve -- but a bare "[DataTable]"
  // on its own also names something real and must not be flagged as unknown.
  const known = new Set([
    ...objects.map((o) => o.name.toLowerCase()),
    ...(metadata?.tables || []).map((t) => t.name.toLowerCase()),
  ]);
  const unknownReferences = [];
  for (const line of lines) {
    for (const match of line.matchAll(BRACKETED)) {
      const inner = match[3].trim();
      if (!known.has(inner.toLowerCase()) && !unknownReferences.includes(inner)) {
        unknownReferences.push(inner);
      }
    }
  }

  const notes = lines.filter((line) => !claimed.has(line));

  return { described, undescribed, unknownReferences, notes };
}

function qualified(obj) {
  return obj.kind === "measure" ? `[${obj.name}]` : `'${obj.table}'[${obj.name}]`;
}

function describeType(item) {
  const bits = [item.dataType].filter(Boolean);
  if (item.formatString) bits.push(`format "${item.formatString}"`);
  return bits.join(" · ");
}

/**
 * The merged card. Structure from the model, meaning from the admin, and
 * nothing from a reference that does not resolve.
 *
 * Returns "" when there is no metadata, so schemaContext can fall back to the
 * typed description without a second check.
 */
function render(metadata, report) {
  if (!metadata) return "";

  const { described, notes, unknownReferences } = reconcile(metadata, report);
  const linesFor = new Map(described.map((d) => [`${d.kind}:${d.name}`, d.lines]));
  const unknown = new Set(unknownReferences.map((r) => r.toLowerCase()));

  // A note that only exists because it references something that is not in
  // the model is the drift reconcile() exists to catch, not prose to keep --
  // repeating it here is exactly the ungrounded behaviour this card replaces.
  const keptNotes = notes.filter((line) => {
    for (const match of line.matchAll(BRACKETED)) {
      if (unknown.has(match[3].trim().toLowerCase())) return false;
    }
    return true;
  });

  const out = [];

  out.push(
    `Read from the semantic model itself. Names and types below are exact — use them verbatim.`
  );

  if (metadata.tables?.length) {
    out.push("\nTABLES");
    for (const t of metadata.tables) {
      const tag = t.dataCategory === "Time" ? " · date table" : "";
      out.push(`  '${t.name}'  ${t.storageMode || ""}${tag}`.trimEnd());
    }
  }

  if (metadata.relationships?.length) {
    out.push("\nRELATIONSHIPS");
    for (const r of metadata.relationships) {
      const tags = [];
      if (r.isActive === false) tags.push("inactive");
      if (r.crossFilteringBehavior === "BothDirections") tags.push("bidirectional");
      out.push(`  ${r.text}${tags.length ? `  (${tags.join(", ")})` : ""}`);
    }
  }

  // NOTES carries the admin's own business rules -- the only place that
  // meaning survives -- so it renders here, right after RELATIONSHIPS and
  // before MEASURES/COLUMNS, rather than last. Callers elsewhere in the app
  // slice this whole string to a fixed character budget before it reaches a
  // prompt; for any model with a non-trivial number of columns, COLUMNS alone
  // can consume that budget, and NOTES must survive regardless of how many
  // measures or columns exist.
  if (keptNotes.length) {
    out.push("\nNOTES");
    keptNotes.forEach((n) => out.push(`  ${n}`));
  }

  const section = (title, items, kind) => {
    if (!items?.length) return;
    out.push(`\n${title}`);
    for (const item of items) {
      const obj = { kind, name: item.name, table: item.table };
      out.push(`  ${qualified(obj)}  ${describeType(item)}`.trimEnd());
      if (item.expression) out.push(`      = ${item.expression}`);
      const lines = linesFor.get(`${kind}:${item.name}`);
      if (lines) lines.forEach((l) => out.push(`      ${l}`));
      else out.push(`      (no description)`);
    }
  };

  section("MEASURES", metadata.measures, "measure");

  // Columns are the most numerous and the least individually load-bearing, so
  // they are what gives way when a model is too wide to fit.
  const before = out.join("\n").length;
  const columnLines = [];
  let omitted = 0;
  for (const col of metadata.columns || []) {
    const obj = { kind: "column", name: col.name, table: col.table };
    const entry = [`  ${qualified(obj)}  ${describeType(col)}`.trimEnd()];
    if (col.expression) entry.push(`      = ${col.expression}`);
    const lines = linesFor.get(`column:${col.name}`);
    if (lines) lines.forEach((l) => entry.push(`      ${l}`));
    else entry.push(`      (no description)`);

    const addition = entry.join("\n").length + 1;
    if (before + columnLines.join("\n").length + addition > BUDGETS.MODEL_CARD_CHARS - 200) {
      omitted += 1;
      continue;
    }
    columnLines.push(...entry);
  }
  if (columnLines.length) {
    out.push("\nCOLUMNS");
    out.push(...columnLines);
  }
  if (omitted) out.push(`  (${omitted} further columns omitted.)`);

  return out.join("\n").slice(0, BUDGETS.MODEL_CARD_CHARS);
}

module.exports = { reconcile, render, MIN_BARE_NAME };
