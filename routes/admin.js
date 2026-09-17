const express = require("express");
const { requireAdmin } = require("../lib/auth");
const {
  getSettings,
  updateSettings,
  getReports,
  createReport,
  updateReport,
  deleteReport,
} = require("../lib/settings");
const {
  getAadToken,
  clearTokenCache,
  listWorkspaces,
  listReports,
  executeQuery,
} = require("../lib/powerbi");

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

// ---------------------------------------------------------------------------
// THROWAWAY SPIKE — delete this whole block once the question is answered.
//
// Can the service principal read the semantic model's own metadata? DAX INFO
// functions run as ordinary table functions inside EVALUATE, so they go
// through executeQueries like any other query -- but Microsoft's docs say
// they "require semantic model admin permissions", which is a higher bar than
// running a query. This either works or returns an authorization error, and
// nothing short of asking the live model settles it.
//
// Hit: GET /api/admin/probe-metadata/<reportId> while logged into /admin.
// ---------------------------------------------------------------------------
const PROBES = [
  ["INFO.VIEW.MEASURES", "EVALUATE INFO.VIEW.MEASURES()"],
  ["INFO.MEASURES", "EVALUATE INFO.MEASURES()"],
  ["INFO.VIEW.COLUMNS", "EVALUATE INFO.VIEW.COLUMNS()"],
  ["INFO.VIEW.TABLES", "EVALUATE INFO.VIEW.TABLES()"],
  ["INFO.VIEW.RELATIONSHIPS", "EVALUATE INFO.VIEW.RELATIONSHIPS()"],
];

router.get("/probe-metadata/:reportId", async (req, res) => {
  const reports = await getReports();
  const report = (reports || []).find((r) => r.id === req.params.reportId);
  if (!report) return res.status(404).json({ error: `Unknown report "${req.params.reportId}"` });
  if (!report.datasetId) return res.status(400).json({ error: "That report has no datasetId" });

  const settings = await getSettings();
  const credentials = {
    tenantId: settings.pbiTenantId,
    clientId: settings.pbiClientId,
    clientSecret: settings.pbiClientSecret,
  };

  const out = [];
  for (const [name, dax] of PROBES) {
    try {
      const rows = await executeQuery(credentials, {
        workspaceId: report.workspaceId,
        datasetId: report.datasetId,
        dax,
      });
      out.push({
        probe: name,
        ok: true,
        rowCount: rows.length,
        columns: rows.length ? Object.keys(rows[0]) : [],
        // Two rows is enough to see the shape without dumping a whole model.
        sample: rows.slice(0, 2),
      });
    } catch (err) {
      out.push({ probe: name, ok: false, error: err.message.slice(0, 500) });
    }
  }

  res.json({ report: report.id, probes: out });
});

module.exports = router;
