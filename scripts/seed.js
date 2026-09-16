// One-time seed: carries the old config/reports.js + config/schema.js
// placeholder over into the DB as an editable row, so nothing is silently
// lost when those static files are removed. Run manually: `node scripts/seed.js`.

require("dotenv/config");
const { pool, migrate } = require("../lib/db");

const SAMPLE_SCHEMA = `
Table 'Sites': one row per physical site.
  - Site (text) — site name, primary key.
  - Region (text) — region the site belongs to.

Table 'Usage': one row per site per day.
  - Date (datetime) — usage date.
  - Site (text) — foreign key to Sites[Site].
  - EnergyUsage (measure, decimal) — total energy usage in kWh for that day.

Example DAX:
EVALUATE
  TOPN(5,
    SUMMARIZECOLUMNS(Sites[Site], "TotalUsage", [EnergyUsage]),
    [TotalUsage], DESC
  )
`.trim();

async function seed() {
  await migrate();
  await pool.query(
    `INSERT INTO reports (id, name, workspace_id, report_id, dataset_id, schema_description, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    ["sample-report", "Sample Report", "", "", "", SAMPLE_SCHEMA, 0]
  );
  console.log("Seeded sample-report placeholder — edit its IDs via /admin once logged in.");
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
