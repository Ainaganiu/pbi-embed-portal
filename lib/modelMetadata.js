// lib/modelMetadata.js
//
// The semantic model's own account of itself, read through the same
// executeQuery path everything else uses.
//
// These are DAX table functions inside EVALUATE, not a separate API, which is
// the whole reason this is viable: no XMLA, no Premium requirement, and no
// permissions beyond what embedding already needed. Established by probe
// against the live model before any of this was built.

const { executeQuery } = require("./powerbi");

// Power BI returns rows keyed by bracketed name, matching the SELECTCOLUMNS
// aliases below.
const QUERIES = {
  tables: `EVALUATE SELECTCOLUMNS(INFO.VIEW.TABLES(), "Name", [Name], "IsHidden", [IsHidden], "DataCategory", [DataCategory], "StorageMode", [StorageMode])`,
  measures: `EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "Name", [Name], "Tbl", [Table], "DataType", [DataType], "FormatString", [FormatString], "Expression", [Expression], "Description", [Description], "IsHidden", [IsHidden])`,
  columns: `EVALUATE SELECTCOLUMNS(FILTER(INFO.VIEW.COLUMNS(), [IsHidden] = FALSE() && [Type] <> "RowNumber"), "Name", [Name], "Tbl", [Table], "DataType", [DataType], "FormatString", [FormatString], "SummarizeBy", [SummarizeBy], "Description", [Description])`,
  relationships: `EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(), "Rel", [Relationship], "IsActive", [IsActive], "FromTable", [FromTable], "ToTable", [ToTable])`,
};

// Power BI generates a hidden date table per date column when auto date/time
// is on. They carry no meaning a user would recognise and would crowd out the
// real model.
const AUTO_DATE_TABLE = /^(DateAutoTemplate|LocalDateTable_)/i;

const val = (row, key) => {
  const v = row?.[`[${key}]`];
  return v === undefined ? null : v;
};

function normalise(raw) {
  const rawTables = Array.isArray(raw?.tables) ? raw.tables : [];
  const rawMeasures = Array.isArray(raw?.measures) ? raw.measures : [];
  const rawColumns = Array.isArray(raw?.columns) ? raw.columns : [];
  const rawRelationships = Array.isArray(raw?.relationships) ? raw.relationships : [];

  const tables = rawTables
    .filter(
      (r) =>
        val(r, "IsHidden") !== true &&
        Boolean(val(r, "Name")) &&
        !AUTO_DATE_TABLE.test(String(val(r, "Name") || ""))
    )
    .map((r) => ({
      name: val(r, "Name"),
      storageMode: val(r, "StorageMode"),
      dataCategory: val(r, "DataCategory"),
    }));

  const kept = new Set(tables.map((t) => t.name));

  const measures = rawMeasures
    .filter((r) => val(r, "IsHidden") !== true && Boolean(val(r, "Name")) && kept.has(val(r, "Tbl")))
    .map((r) => ({
      name: val(r, "Name"),
      table: val(r, "Tbl"),
      dataType: val(r, "DataType"),
      formatString: val(r, "FormatString"),
      expression: val(r, "Expression"),
      description: val(r, "Description"),
    }));

  // The DAX filter already drops RowNumber columns, but a column can also be
  // noise by association: one belonging to an auto-date table looks perfectly
  // ordinary on its own.
  const columns = rawColumns
    .filter(
      (r) =>
        Boolean(val(r, "Name")) &&
        !String(val(r, "Name") || "").startsWith("RowNumber-") &&
        kept.has(val(r, "Tbl"))
    )
    .map((r) => ({
      name: val(r, "Name"),
      table: val(r, "Tbl"),
      dataType: val(r, "DataType"),
      formatString: val(r, "FormatString"),
      summarizeBy: val(r, "SummarizeBy"),
      description: val(r, "Description"),
      // Always null from this acquisition path -- executeQueries never
      // requests it, since it would be redacted anyway. Set by
      // mergeDefinition() when a Fabric read succeeds.
      expression: null,
    }));

  // A relationship to an excluded table (e.g. an auto-date table) carries that
  // table's name into the card even though the relationship row itself has no
  // hidden flag of its own -- both ends must survive independently.
  const relationships = rawRelationships
    .filter(
      (r) => Boolean(val(r, "Rel")) && kept.has(val(r, "FromTable")) && kept.has(val(r, "ToTable"))
    )
    .map((r) => ({
      text: val(r, "Rel"),
      isActive: val(r, "IsActive"),
      fromTable: val(r, "FromTable"),
      toTable: val(r, "ToTable"),
      // Always null from this acquisition path -- INFO.VIEW.RELATIONSHIPS
      // has no such field. Set by mergeDefinition() when a Fabric read
      // succeeds.
      crossFilteringBehavior: null,
    }));

  return { tables, measures, columns, relationships };
}

/**
 * Reads the model. Resolves to null on any failure -- a report whose metadata
 * cannot be read must keep working on its typed description alone.
 */
async function fetchModelMetadata(credentials, { workspaceId, datasetId }) {
  if (!workspaceId || !datasetId) return null;

  const raw = {};
  for (const [section, dax] of Object.entries(QUERIES)) {
    try {
      raw[section] = await executeQuery(credentials, { workspaceId, datasetId, dax });
    } catch (err) {
      console.error(`[model metadata] ${section} failed:`, err.message);
      return null;
    }
  }
  const normalised = normalise(raw);
  // A response that comes back well-formed but empty -- an unexpected shape,
  // or a permission mode that yields empty result sets rather than an error
  // -- is indistinguishable from a real model with zero tables, and treating
  // it as a successful read would silently replace a good typed description
  // with an empty-but-assertive card. Treat it as a failed read instead.
  if (normalised.tables.length === 0) return null;
  return normalised;
}

/**
 * Overlays real DAX (from fetchModelDefinition) onto normalised metadata,
 * matching by name -- table+name for columns and relationships, since names
 * alone aren't unique across tables. A null definition returns metadata
 * completely unchanged: a Fabric-fetch failure alongside a successful
 * INFO.VIEW read must look exactly like a sync that never had this feature.
 */
function mergeDefinition(metadata, definition) {
  if (!definition) return metadata;

  const measureExpr = new Map(definition.measures.map((m) => [m.name, m.expression]));
  const columnExpr = new Map(definition.columns.map((c) => [`${c.table}::${c.name}`, c.expression]));
  const relBehavior = new Map(
    definition.relationships.map((r) => [`${r.fromTable}::${r.toTable}`, r.crossFilteringBehavior])
  );

  return {
    ...metadata,
    measures: metadata.measures.map((m) => ({
      ...m,
      expression: measureExpr.get(m.name) ?? m.expression,
    })),
    columns: metadata.columns.map((c) => ({
      ...c,
      expression: columnExpr.get(`${c.table}::${c.name}`) ?? c.expression,
    })),
    relationships: metadata.relationships.map((r) => ({
      ...r,
      crossFilteringBehavior: relBehavior.get(`${r.fromTable}::${r.toTable}`) ?? r.crossFilteringBehavior,
    })),
  };
}

module.exports = { fetchModelMetadata, normalise, mergeDefinition };
