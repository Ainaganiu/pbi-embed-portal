// Plain-text description of each dataset's tables, columns, and measures.
// This is sent to the LLM on every chat request as the source of truth for
// what DAX it's allowed to write — there is no schema introspection and no
// DAX validation in this MVP, so the accuracy of these descriptions is the
// single biggest lever on whether the chat panel gives correct answers.
//
// Keys must match the `schemaKey` used in config/reports.js.
//
// Write these the way you'd brief a new analyst: table names, exactly as
// they appear in the model, then columns/measures with their real names and
// a one-line description of what they mean and any relevant grain/units.

module.exports = {
  "sample-report": `
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
`.trim(),
};
