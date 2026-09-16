// Registry of embeddable reports. Add one entry per Power BI report you want
// to expose through the portal. `datasetId` + `schemaKey` are only needed if
// you want the AI chat/chart panel enabled for that report — leave them out
// (or leave the schema empty) and the report still embeds fine, just without
// chat.
//
// To add a report:
//   1. Add PBI_WORKSPACE_ID_<NAME>, PBI_REPORT_ID_<NAME>, PBI_DATASET_ID_<NAME>
//      to your .env (see .env.example).
//   2. Add an entry below.
//   3. (Optional) Describe the dataset's schema in config/schema.js under the
//      same schemaKey, so the chat panel can generate accurate DAX for it.

module.exports = [
  {
    id: "sample-report",
    name: "Sample Report",
    workspaceId: process.env.PBI_WORKSPACE_ID_SAMPLE,
    reportId: process.env.PBI_REPORT_ID_SAMPLE,
    datasetId: process.env.PBI_DATASET_ID_SAMPLE,
    schemaKey: "sample-report",
  },

  // {
  //   id: "energy-usage",
  //   name: "Energy Usage",
  //   workspaceId: process.env.PBI_WORKSPACE_ID_ENERGY,
  //   reportId: process.env.PBI_REPORT_ID_ENERGY,
  //   datasetId: process.env.PBI_DATASET_ID_ENERGY,
  //   schemaKey: "energy-usage",
  // },
];
