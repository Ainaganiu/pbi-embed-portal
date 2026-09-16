# Power BI Embedded Portal (MVP)

A simple web app that embeds Power BI reports for external users, so they
can view reports in the browser without needing their own Power BI license —
plus an optional AI chat panel that can answer questions about the data and
render a quick chart alongside the answer.

The embed itself has no dependency on the chat feature: if you don't
configure an LLM, the portal just embeds reports, full stop.

---

## What it does

- **Embeds Power BI reports** using app-owns-data (service principal) auth,
  so viewers never need a Power BI license or account.
- **Supports multiple reports** behind a simple dropdown/menu, so one portal
  can serve several reports without separate deployments.
- **Runs on the cheapest viable capacity tier** — no special licensing
  beyond a Power BI Pro/Premium workspace for publishing.
- **(Optional) Answers questions with a text summary and a chart** — a
  question like *"which sites had the highest energy usage last month?"*
  is turned into a DAX query, run against the live dataset, and answered
  with both a short plain-English summary and a small bar/line chart
  rendered client-side from the same result rows.

---

## How it works

```
┌──────────────┐   GET /api/embed-token/:id   ┌──────────────┐
│   Browser     │ ───────────────────────────> │  Express      │
│ (powerbi-     │                              │  server       │
│  client JS)   │ <─────────────────────────── │               │
└──────────────┘   { accessToken, embedUrl }    └──────────────┘
                                                      │
                                                      │ GenerateToken
                                                      ▼
                                              ┌──────────────┐
                                              │  Power BI     │
                                              │  REST API     │
                                              └──────────────┘
```

1. Browser loads the portal and asks the server for an embed token for a
   given report.
2. The server (using a service principal) calls Power BI's `GenerateToken`
   API and returns a short-lived access token + embed URL.
3. The browser uses `powerbi-client` to render the report directly, with no
   further server involvement until the token expires.

### Optional: AI chat + chart flow

```
┌─────────────┐   question    ┌──────────┐   DAX query   ┌────────────────┐
│ Chat panel  │ ────────────> │   LLM    │ ────────────> │ Power BI        │
│ (browser)   │               │          │               │ Execute Queries │
└─────────────┘               └──────────┘               └────────────────┘
       ▲                            ▲                              │
       │   text answer +            │         result rows          │
       │   chart spec (JSON)        └──────────────────────────────┘
       │                            │
       └── rendered with Chart.js ──┘
```

1. User asks a question in the chat panel.
2. The server sends the question, plus a description of the semantic model
   (tables, columns, measures), to an LLM, which returns a DAX query.
3. The server runs that query via Power BI's `executeQueries` REST API,
   using the same service principal used for embedding.
4. The result rows go back to the LLM, which returns a short plain-English
   answer **and** a small chart spec — chart type (bar/line), labels, and
   values.
5. The browser renders the text answer and draws the chart client-side
   with Chart.js. No chart is generated if the question doesn't call for
   one (e.g. a yes/no or single-number answer) — the panel just shows text.

The embedded report itself is unaffected by any of this — it's a standard
app-owns-data embed, rendered client-side with `powerbi-client`, entirely
separate from whatever the chat panel draws.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + Express | Minimal, matches Microsoft's own sample apps |
| Frontend | Vanilla JS + `powerbi-client` | No build step, fastest path to a working demo |
| Auth | Azure AD service principal (client credentials) | No per-user Power BI licenses needed |
| LLM *(optional)* | Any OpenAI-compatible chat completions API | Swappable; only needed if the chat panel is enabled |
| Charting *(optional)* | Chart.js (client-side) | Lightweight, no build step, renders straight from the LLM's chart spec |
| Hosting | Render (or any Node host) | Free/cheap tier sufficient for MVP traffic |

---

## Project structure

```
pbi-embed-portal/
├── server.js              # Embed token endpoint + optional chat/chart pipeline
├── config/
│   ├── reports.js          # Registry of embeddable reports (edit this)
│   └── schema.js            # Semantic model description, used by the LLM (optional)
├── public/
│   ├── index.html            # Report selector + embed container + chat panel
│   ├── app.js                 # Fetches token, embeds report, wires up chat + chart
│   └── style.css
├── .env.example
├── package.json
└── README.md
```

The chat panel and everything under `config/schema.js` are only active if
`LLM_API_KEY` is set — leave it blank to run as an embed-only portal.

---

## Setup

### 1. Prerequisites

- A Power BI workspace assigned to a Pro/Premium/Fabric capacity, with your
  report(s) published to it
- An Azure AD app registration (service principal) with a client secret
- "Allow service principals to use Power BI APIs" enabled in the Power BI
  admin portal
- The service principal added as a member of the workspace(s)

### 2. Configure

```bash
cp .env.example .env
```

Fill in your tenant ID, client ID/secret, and each report's workspace ID +
report ID. Then list each report in `config/reports.js`:

```js
module.exports = [
  {
    id: "sales-overview",
    name: "Sales Overview",
    workspaceId: process.env.PBI_WORKSPACE_ID_SALES,
    reportId: process.env.PBI_REPORT_ID_SALES,
  },
  {
    id: "energy-usage",
    name: "Energy Usage",
    workspaceId: process.env.PBI_WORKSPACE_ID_ENERGY,
    reportId: process.env.PBI_REPORT_ID_ENERGY,
  },
];
```

### 3. (Optional) Enable the AI chat + chart panel

Leave `LLM_API_KEY` blank in `.env` to run as an embed-only portal. To
enable the chat panel:

1. Fill in `LLM_API_KEY`, `LLM_API_BASE`, and `LLM_MODEL` in `.env`.
2. Edit `config/schema.js` to describe your dataset's tables, columns, and
   measures. This is sent to the LLM on every chat request, so accuracy
   here directly drives how often the generated DAX — and the resulting
   chart — is correct.
3. Add each report's dataset ID to `.env` (`PBI_DATASET_ID_*`), since chart
   answers need to query the dataset directly, not just embed the report.

### 4. Run locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`.

### 5. Deploy to Render

1. Push the project to a GitHub repo.
2. Render → **New → Web Service** → connect the repo.
3. Build command: `npm install` · Start command: `npm start`
4. Add every variable from `.env.example` under Render's environment
   variables (never commit your real `.env`).
5. Deploy — Render gives you a public URL.

---

## Known limitations (MVP scope)

- **No login on the portal** — anyone with the URL can view every listed
  report.
- **No row-level security** — the embed token grants full report access.
  Add `identities` with roles to `GenerateToken` and matching RLS roles in
  the model to scope data per user.
- **No per-user report visibility** — every visitor sees every report in
  the list; there's no concept of "this client only sees these two
  reports."
- **Tokens expire** — the MVP doesn't auto-refresh the embed token, so a
  long-open tab will eventually need a page reload.
- **(If chat is enabled) No DAX validation** — generated queries run
  directly against the dataset without being checked against the schema
  first.
- **(If chat is enabled) Chart type is chosen by the LLM, not the user** —
  it picks bar vs. line based on the question and data shape; there's no
  manual chart-type override yet.
- **(If chat is enabled) No conversation memory** — each question is
  handled independently; follow-ups like *"and last quarter?"* won't have
  context, and won't remember the previous chart.

---

## Roadmap (post-MVP)

- [ ] Add authentication (e.g. simple email/password or SSO)
- [ ] Per-user/per-client report visibility
- [ ] RLS-aware embed tokens per client
- [ ] Auto-refresh embed tokens before they expire
- [ ] Custom theming / branding per client
- [ ] Usage analytics (which reports get viewed, by whom)
- [ ] Validate generated DAX against the schema before execution
- [ ] Add prompt caching for the schema payload (chat mode)
- [ ] Let users pick/override the chart type (bar, line, pie, table)
- [ ] Add short-term conversation memory to the chat
- [ ] Support additional chart types beyond bar/line (e.g. stacked, %)
