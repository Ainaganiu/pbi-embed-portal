// Reads/writes the singleton `settings` row and the `reports` table,
// replacing the old process.env + config/*.js static configuration.
// Results are cached in-memory and invalidated on every write, so hot paths
// (embed token, chat) don't hit Postgres on every request.

const { pool } = require("./db");
const { encrypt, decrypt } = require("./crypto");

let cache = null; // { settings, reports } | null

function rowToSettings(row) {
  return {
    portalName: row.portal_name,
    logoDataUri: row.logo_data_uri,
    accentColor: row.accent_color,
    pbiTenantId: row.pbi_tenant_id,
    pbiClientId: row.pbi_client_id,
    pbiClientSecret: row.pbi_client_secret_encrypted ? decrypt(row.pbi_client_secret_encrypted) : null,
    pbiClientSecretSet: Boolean(row.pbi_client_secret_encrypted),
    llmProvider: row.llm_provider,
    llmApiKey: row.llm_api_key_encrypted ? decrypt(row.llm_api_key_encrypted) : null,
    llmApiKeySet: Boolean(row.llm_api_key_encrypted),
    llmModel: row.llm_model,
    llmApiBase: row.llm_api_base,
  };
}

function rowToReport(row) {
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspace_id,
    reportId: row.report_id,
    datasetId: row.dataset_id,
    schemaDescription: row.schema_description,
    sortOrder: row.sort_order,
  };
}

async function loadFromDb() {
  const settingsResult = await pool.query("SELECT * FROM settings WHERE id = 1");
  const reportsResult = await pool.query("SELECT * FROM reports ORDER BY sort_order, name");
  return {
    settings: rowToSettings(settingsResult.rows[0]),
    reports: reportsResult.rows.map(rowToReport),
  };
}

function invalidateCache() {
  cache = null;
}

async function getSettings() {
  if (!cache) cache = await loadFromDb();
  return cache.settings;
}

async function getReports() {
  if (!cache) cache = await loadFromDb();
  return cache.reports;
}

async function getReport(id) {
  const reports = await getReports();
  return reports.find((r) => r.id === id) || null;
}

const SETTINGS_COLUMNS = {
  portalName: "portal_name",
  logoDataUri: "logo_data_uri",
  accentColor: "accent_color",
  pbiTenantId: "pbi_tenant_id",
  pbiClientId: "pbi_client_id",
  llmProvider: "llm_provider",
  llmModel: "llm_model",
  llmApiBase: "llm_api_base",
};

async function updateSettings(partial) {
  const sets = [];
  const values = [];
  let i = 1;

  for (const [key, column] of Object.entries(SETTINGS_COLUMNS)) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) {
      sets.push(`${column} = $${i}`);
      values.push(partial[key]);
      i += 1;
    }
  }

  // Secrets: only overwrite when a non-empty value is submitted. An empty
  // string / undefined means "leave the currently-stored secret alone".
  if (partial.pbiClientSecret) {
    sets.push(`pbi_client_secret_encrypted = $${i}`);
    values.push(encrypt(partial.pbiClientSecret));
    i += 1;
  }
  if (partial.llmApiKey) {
    sets.push(`llm_api_key_encrypted = $${i}`);
    values.push(encrypt(partial.llmApiKey));
    i += 1;
  }

  if (sets.length === 0) return;

  sets.push("updated_at = now()");
  await pool.query(`UPDATE settings SET ${sets.join(", ")} WHERE id = 1`, values);
  invalidateCache();
}

async function createReport(data) {
  await pool.query(
    `INSERT INTO reports (id, name, workspace_id, report_id, dataset_id, schema_description, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      data.id,
      data.name,
      data.workspaceId,
      data.reportId,
      data.datasetId || null,
      data.schemaDescription || null,
      data.sortOrder || 0,
    ]
  );
  invalidateCache();
  return getReport(data.id);
}

async function updateReport(id, data) {
  await pool.query(
    `UPDATE reports
     SET name = $2, workspace_id = $3, report_id = $4, dataset_id = $5,
         schema_description = $6, sort_order = $7
     WHERE id = $1`,
    [
      id,
      data.name,
      data.workspaceId,
      data.reportId,
      data.datasetId || null,
      data.schemaDescription || null,
      data.sortOrder || 0,
    ]
  );
  invalidateCache();
  return getReport(id);
}

async function deleteReport(id) {
  await pool.query("DELETE FROM reports WHERE id = $1", [id]);
  invalidateCache();
}

module.exports = {
  getSettings,
  getReports,
  getReport,
  updateSettings,
  createReport,
  updateReport,
  deleteReport,
  invalidateCache,
};
