require("dotenv/config");
const path = require("node:path");
const express = require("express");
const session = require("express-session");

const { migrate } = require("./lib/db");
const { syncAdminFromEnv } = require("./lib/auth");
const { getSettings, getReports, getReport } = require("./lib/settings");
const { generateEmbedToken } = require("./lib/powerbi");
const { getProvider } = require("./lib/llm");
const authRouter = require("./routes/auth");
const adminRouter = require("./routes/admin");
const chatRouter = require("./routes/chat");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-insecure-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/chat", chatRouter);

function settingsUnavailable(res, err) {
  res.status(503).json({ error: `Settings database unavailable: ${err.message}` });
}

function chatEnabledFor(report, settings) {
  return Boolean(getProvider({
    provider: settings.llmProvider,
    apiKey: settings.llmApiKey,
  }) && report?.datasetId && report?.schemaDescription);
}

// Branding — used by the public portal to render name/logo/accent color.
app.get("/api/branding", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({
      portalName: settings.portalName,
      logoDataUri: settings.logoDataUri,
      accentColor: settings.accentColor,
    });
  } catch (err) {
    settingsUnavailable(res, err);
  }
});

// List reports available to embed, and whether each has chat/chart enabled.
app.get("/api/reports", async (req, res) => {
  try {
    const [settings, reports] = await Promise.all([getSettings(), getReports()]);
    res.json(
      reports.map((r) => ({
        id: r.id,
        name: r.name,
        hasChat: chatEnabledFor(r, settings),
      }))
    );
  } catch (err) {
    settingsUnavailable(res, err);
  }
});

// Mint a short-lived embed token for a given report.
app.get("/api/embed-token/:id", async (req, res) => {
  let settings, report;
  try {
    settings = await getSettings();
    report = await getReport(req.params.id);
  } catch (err) {
    return settingsUnavailable(res, err);
  }
  if (!report) {
    return res.status(404).json({ error: `Unknown report "${req.params.id}"` });
  }

  try {
    const token = await generateEmbedToken(
      { tenantId: settings.pbiTenantId, clientId: settings.pbiClientId, clientSecret: settings.pbiClientSecret },
      { workspaceId: report.workspaceId, reportId: report.reportId }
    );
    res.json(token);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message || "Internal server error" });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  migrate()
    .then(() => syncAdminFromEnv())
    .catch((err) => {
      console.error("Database migration failed at startup (will retry lazily on first request):", err.message);
    })
    .finally(() => {
      app.listen(port, () => {
        console.log(`pbi-embed-portal listening on http://localhost:${port}`);
      });
    });
}

module.exports = app;
