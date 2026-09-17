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
    .filter((r) => val(r, "IsHidden") !== true && !AUTO_DATE_TABLE.test(String(val(r, "Name") || "")))
    .map((r) => ({
      name: val(r, "Name"),
      storageMode: val(r, "StorageMode"),
      dataCategory: val(r, "DataCategory"),
    }));

  const kept = new Set(tables.map((t) => t.name));

  const measures = rawMeasures
    .filter((r) => val(r, "IsHidden") !== true && kept.has(val(r, "Tbl")))
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
    .filter((r) => !String(val(r, "Name") || "").startsWith("RowNumber-") && kept.has(val(r, "Tbl")))
    .map((r) => ({
      name: val(r, "Name"),
      table: val(r, "Tbl"),
      dataType: val(r, "DataType"),
      formatString: val(r, "FormatString"),
      summarizeBy: val(r, "SummarizeBy"),
      description: val(r, "Description"),
    }));

  // A relationship to an excluded table (e.g. an auto-date table) carries that
  // table's name into the card even though the relationship row itself has no
  // hidden flag of its own -- both ends must survive independently.
  const relationships = rawRelationships
    .filter((r) => kept.has(val(r, "FromTable")) && kept.has(val(r, "ToTable")))
    .map((r) => ({
      text: val(r, "Rel"),
      isActive: val(r, "IsActive"),
      fromTable: val(r, "FromTable"),
      toTable: val(r, "ToTable"),
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
  return normalise(raw);
}

module.exports = { fetchModelMetadata, normalise };
