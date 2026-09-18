// test/settings.test.js
//
// updateReport deliberately leaves model_metadata alone on an ordinary save
// (Task 2's design: a stale form save must not wipe a fresh sync). But
// repointing a report at a different dataset makes the OLD model's names
// wrong for the new dataset, so that specific case must clear the cached
// card. This mocks lib/db's pool so the test never needs a real Postgres.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function installFakePool(reportsSeed) {
  const dbPath = require.resolve(path.join(ROOT, "lib/db"));
  const originalDb = require.cache[dbPath];

  const reports = reportsSeed.map((r) => ({ ...r }));
  const settingsRow = {
    id: 1,
    portal_name: "Test Portal",
    logo_data_uri: null,
    accent_color: "#000",
    pbi_tenant_id: null,
    pbi_client_id: null,
    pbi_client_secret_encrypted: null,
    llm_provider: "anthropic",
    llm_api_key_encrypted: null,
    llm_model: null,
    llm_api_base: null,
  };

  const pool = {
    async query(sql, values = []) {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.startsWith("SELECT dataset_id FROM reports WHERE id = $1")) {
        const row = reports.find((r) => r.id === values[0]);
        return { rows: row ? [{ dataset_id: row.dataset_id }] : [] };
      }
      if (s.startsWith("SELECT * FROM settings")) {
        return { rows: [settingsRow] };
      }
      if (s.startsWith("SELECT * FROM reports")) {
        return { rows: reports.map((r) => ({ ...r })) };
      }
      if (s.startsWith("UPDATE reports SET")) {
        const id = values[0];
        const row = reports.find((r) => r.id === id);
        if (row) {
          row.name = values[1];
          row.workspace_id = values[2];
          row.report_id = values[3];
          row.dataset_id = values[4];
          row.schema_description = values[5];
          row.problem_statement = values[6];
          row.measures_description = values[7];
          row.columns_description = values[8];
          row.sort_order = values[9];
          if (s.includes("model_metadata = NULL")) {
            row.model_metadata = null;
            row.model_metadata_synced_at = null;
          }
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query in test: ${s}`);
    },
  };

  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: { pool, migrate: async () => {} },
  };

  // lib/starters requires lib/db too (via clearStarterCache's module) --
  // load lib/settings fresh so it picks up the fake pool.
  delete require.cache[require.resolve(path.join(ROOT, "lib/settings"))];
  const settings = require(path.join(ROOT, "lib/settings"));

  return {
    settings,
    reports,
    restore() {
      if (originalDb) require.cache[dbPath] = originalDb;
      else delete require.cache[dbPath];
      delete require.cache[require.resolve(path.join(ROOT, "lib/settings"))];
    },
  };
}

test("changing datasetId clears model_metadata and model_metadata_synced_at", async () => {
  const { settings, restore } = installFakePool([
    {
      id: "r1",
      name: "Report 1",
      workspace_id: "w1",
      report_id: "rep1",
      dataset_id: "old-dataset",
      schema_description: null,
      problem_statement: null,
      measures_description: null,
      columns_description: null,
      model_metadata: { tables: [{ name: "T" }] },
      model_metadata_synced_at: new Date(),
      sort_order: 0,
    },
  ]);

  try {
    const updated = await settings.updateReport("r1", {
      name: "Report 1",
      workspaceId: "w1",
      reportId: "rep1",
      datasetId: "new-dataset",
    });
    assert.equal(updated.datasetId, "new-dataset");
    assert.equal(updated.modelMetadata, null, "the old model's card must not survive a dataset change");
    assert.equal(updated.modelMetadataSyncedAt, null);
  } finally {
    restore();
  }
});

test("not changing datasetId leaves model_metadata untouched", async () => {
  const syncedAt = new Date();
  const { settings, restore } = installFakePool([
    {
      id: "r1",
      name: "Report 1",
      workspace_id: "w1",
      report_id: "rep1",
      dataset_id: "same-dataset",
      schema_description: null,
      problem_statement: null,
      measures_description: null,
      columns_description: null,
      model_metadata: { tables: [{ name: "T" }] },
      model_metadata_synced_at: syncedAt,
      sort_order: 0,
    },
  ]);

  try {
    const updated = await settings.updateReport("r1", {
      name: "Report 1 renamed",
      workspaceId: "w1",
      reportId: "rep1",
      datasetId: "same-dataset",
    });
    assert.equal(updated.name, "Report 1 renamed");
    assert.deepEqual(updated.modelMetadata, { tables: [{ name: "T" }] });
    assert.equal(updated.modelMetadataSyncedAt, syncedAt.toISOString());
  } finally {
    restore();
  }
});

test("a report with no metadata yet and no dataset change stays that way", async () => {
  const { settings, restore } = installFakePool([
    {
      id: "r1",
      name: "Report 1",
      workspace_id: "w1",
      report_id: "rep1",
      dataset_id: "ds1",
      schema_description: null,
      problem_statement: null,
      measures_description: null,
      columns_description: null,
      model_metadata: null,
      model_metadata_synced_at: null,
      sort_order: 0,
    },
  ]);

  try {
    const updated = await settings.updateReport("r1", {
      name: "Report 1",
      workspaceId: "w1",
      reportId: "rep1",
      datasetId: "ds1",
    });
    assert.equal(updated.modelMetadata, null);
    assert.equal(updated.modelMetadataSyncedAt, null);
  } finally {
    restore();
  }
});

test("setting a datasetId for the first time (was null) also clears metadata defensively", async () => {
  const { settings, restore } = installFakePool([
    {
      id: "r1",
      name: "Report 1",
      workspace_id: "w1",
      report_id: "rep1",
      dataset_id: null,
      schema_description: null,
      problem_statement: null,
      measures_description: null,
      columns_description: null,
      model_metadata: null,
      model_metadata_synced_at: null,
      sort_order: 0,
    },
  ]);

  try {
    const updated = await settings.updateReport("r1", {
      name: "Report 1",
      workspaceId: "w1",
      reportId: "rep1",
      datasetId: "ds1",
    });
    assert.equal(updated.datasetId, "ds1");
    assert.equal(updated.modelMetadata, null);
  } finally {
    restore();
  }
});
