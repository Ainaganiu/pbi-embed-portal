// lib/modelCard.js
//
// The model knows its structure and nothing about what any of it means; the
// admin knows the meaning and has no guarantee the names they typed still
// exist. This joins the two and, just as importantly, reports where they
// disagree -- a description naming a measure that was renamed goes on
// teaching the model to write DAX against something that is not there.

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
  // both, and only the column part needs to resolve.
  const known = new Set(objects.map((o) => o.name.toLowerCase()));
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

module.exports = { reconcile, MIN_BARE_NAME };
