const express = require("express");
const { requireAdmin } = require("../lib/auth");
const {
  getSettings,
  updateSettings,
  getReports,
  createReport,
  updateReport,
  deleteReport,
  setModelMetadata,
} = require("../lib/settings");
const {
  getAadToken,
  clearTokenCache,
  listWorkspaces,
  listReports,
  executeQuery,
} = require("../lib/powerbi");
const { fetchModelMetadata } = require("../lib/modelMetadata");
const { reconcile } = require("../lib/modelCard");

const router = express.Router();
router.use(requireAdmin);

const MAX_LOGO_LENGTH = 300_000; // ~220KB binary, base64-inflated

router.get("/settings", async (req, res) => {
  const settings = await getSettings();
  res.json({
    portalName: settings.portalName,
    logoDataUri: settings.logoDataUri,
    accentColor: settings.accentColor,
    pbiTenantId: settings.pbiTenantId,
    pbiClientId: settings.pbiClientId,
    pbiClientSecretSet: settings.pbiClientSecretSet,
    llmProvider: settings.llmProvider,
    llmApiKeySet: settings.llmApiKeySet,
    llmModel: settings.llmModel,
    llmApiBase: settings.llmApiBase,
  });
});

router.put("/settings", async (req, res) => {
  const body = req.body || {};
  if (body.logoDataUri && body.logoDataUri.length > MAX_LOGO_LENGTH) {
    return res.status(400).json({ error: "Logo is too large (max ~200KB)" });
  }
  await updateSettings(body);
  clearTokenCache();
  res.json({ ok: true });
});

router.post("/test-powerbi", async (req, res) => {
  const { tenantId, clientId, clientSecret } = req.body || {};
  const settings = await getSettings();
  try {
    await getAadToken({
      tenantId: tenantId || settings.pbiTenantId,
      clientId: clientId || settings.pbiClientId,
      clientSecret: clientSecret || settings.pbiClientSecret,
      skipCache: true,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get("/powerbi/workspaces", async (req, res) => {
  const settings = await getSettings();
  try {
    const workspaces = await listWorkspaces({
      tenantId: settings.pbiTenantId,
      clientId: settings.pbiClientId,
      clientSecret: settings.pbiClientSecret,
    });
    res.json(workspaces);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/powerbi/workspaces/:workspaceId/reports", async (req, res) => {
  const settings = await getSettings();
  try {
    const reports = await listReports(
      {
        tenantId: settings.pbiTenantId,
        clientId: settings.pbiClientId,
        clientSecret: settings.pbiClientSecret,
      },
      req.params.workspaceId
    );
    res.json(reports);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/reports", async (req, res) => {
  res.json(await getReports());
});

router.post("/reports", async (req, res) => {
  const body = req.body || {};
  if (!body.id || !body.name || !body.workspaceId || !body.reportId) {
    return res.status(400).json({ error: "id, name, workspaceId, and reportId are required" });
  }
  try {
    const report = await createReport(body);
    res.status(201).json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/reports/:id", async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.workspaceId || !body.reportId) {
    return res.status(400).json({ error: "name, workspaceId, and reportId are required" });
  }
  const report = await updateReport(req.params.id, body);
  if (!report) {
    return res.status(404).json({ error: `Unknown report "${req.params.id}"` });
  }
  res.json(report);
});

router.delete("/reports/:id", async (req, res) => {
  await deleteReport(req.params.id);
  res.json({ ok: true });
});

router.post("/reports/:id/sync-model", async (req, res) => {
  const reports = await getReports();
  const report = (reports || []).find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: `Unknown report "${req.params.id}"` });
  if (!report.datasetId) {
    return res.status(400).json({ error: "This report has no dataset to read." });
  }

  const settings = await getSettings();
  const metadata = await fetchModelMetadata(
    {
      tenantId: settings.pbiTenantId,
      clientId: settings.pbiClientId,
      clientSecret: settings.pbiClientSecret,
    },
    { workspaceId: report.workspaceId, datasetId: report.datasetId }
  );

  // Deliberately not written: a failed refresh must not leave the report
  // worse off than it was before someone pressed the button.
  if (!metadata) {
    return res.status(502).json({
      error: "Couldn't read this model's metadata. The service principal may not have access to it.",
    });
  }

  const saved = await setModelMetadata(report.id, metadata);
  const { described, undescribed, unknownReferences } = reconcile(metadata, saved);

  res.json({
    syncedAt: saved.modelMetadataSyncedAt,
    counts: {
      tables: metadata.tables.length,
      measures: metadata.measures.length,
      columns: metadata.columns.length,
      relationships: metadata.relationships.length,
    },
    reconciliation: {
      describedCount: described.length,
      undescribed: undescribed.map((u) => `${u.kind === "measure" ? "[" + u.name + "]" : "'" + u.table + "'[" + u.name + "]"}`),
      unknownReferences,
    },
  });
});

module.exports = router;
