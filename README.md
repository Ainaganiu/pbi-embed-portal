# Power BI Embedded Portal (MVP)

A simple web app that embeds Power BI reports for external users via
app-owns-data (service principal) auth — no Power BI license needed to view —
plus an optional AI chat panel that answers questions about the data and
draws a quick chart alongside the answer.

The embed itself has no dependency on the chat feature: if you don't
configure an LLM, the portal just embeds reports, full stop.

## Architecture

```
Browser (powerbi-client) --GET /api/embed-token/:id--> Express server --GenerateToken--> Power BI REST API
```

The browser asks the server for an embed token for a report; the server, using
a service principal, calls Power BI's `GenerateToken` API and returns a
short-lived access token + embed URL. `powerbi-client` renders the report
directly after that — no further server involvement until the token expires.

If chat is enabled, a question flows: browser -> server -> LLM (generates
DAX) -> Power BI `executeQueries` -> LLM again (turns rows into a plain-English
answer + optional chart spec) -> browser renders the answer and, if present, a
Chart.js chart.

## Project structure

```
server.js              # Express app: static assets, /api/reports, /api/embed-token/:id, /api/chat
lib/powerbi.js          # AAD token cache, GenerateToken, executeQueries
lib/llm/                # Pluggable LLM adapters (anthropic, openai, deepseek, gemini)
config/reports.js       # Registry of embeddable reports (edit this)
config/schema.js        # Semantic model description per report, used by the LLM
public/                 # index.html + app.js (powerbi-client, Chart.js, chat UI) + style.css
render.yaml             # Render Blueprint
```

## Setup

### 1. Prerequisites

- A Power BI workspace assigned to a Pro/Premium/Fabric capacity, with your
  report(s) published to it.
- An Azure AD app registration (service principal) with a client secret.
- "Allow service principals to use Power BI APIs" enabled in the Power BI
  admin portal.
- The service principal added as a member of the workspace(s).

### 2. Configure

```bash
cp .env.example .env
```

Fill in your tenant ID, client ID/secret, and each report's workspace ID,
report ID, and dataset ID (dataset ID is only needed for the chat panel). Then
list each report in `config/reports.js` — see the worked `sample-report` entry
and the commented example below it.

### 3. (Optional) Enable the AI chat + chart panel

Leave `LLM_API_KEY` blank in `.env` to run as an embed-only portal. To enable
chat for a report:

1. Set `LLM_PROVIDER` (`anthropic` | `openai` | `deepseek` | `gemini`) and
   `LLM_API_KEY` in `.env`. `LLM_MODEL` / `LLM_API_BASE` are optional overrides
   — each provider ships a sensible default:

   | Provider | Default base URL | Default model |
   |---|---|---|
   | `anthropic` | `https://api.anthropic.com/v1` | `claude-sonnet-5` |
   | `openai` | `https://api.openai.com/v1` | `gpt-4o` |
   | `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
   | `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `gemini-2.5-flash` |

2. Add the report's dataset ID to `.env` (`PBI_DATASET_ID_*`) — chat answers
   query the dataset directly, not just the embedded report.
3. Describe the dataset's tables, columns, and measures in `config/schema.js`
   under the matching `schemaKey`. **This is the highest-leverage file for
   chat quality** — it's sent to the LLM on every request, and directly drives
   how often the generated DAX (and the resulting chart) is correct.

A report only shows the chat panel once all three are true: an LLM key is set,
the report has a `datasetId`, and its `schemaKey` has a non-empty entry in
`config/schema.js`.

### 4. Run locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`.

### 5. Deploy to Render

This repo includes a `render.yaml` Blueprint.

1. Push the project to a GitHub repo.
2. In Render: **New → Blueprint** → connect the repo. Render reads
   `render.yaml` and creates the web service.
3. Fill in every variable marked `sync: false` (all the secrets) in the
   Render dashboard — they are intentionally left out of the Blueprint so
   nothing sensitive lives in the repo.
4. Deploy — Render gives you a public URL.

Note: the `free` plan spins down after inactivity, so the first request after
idle time will be slow while the instance wakes up. Bump `plan` in
`render.yaml` if that's not acceptable.

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
  first. The generated DAX is returned alongside the answer so you can spot
  check it.
- **(If chat is enabled) Chart type is chosen by the LLM, not the user** —
  it picks bar vs. line based on the question and data shape; there's no
  manual chart-type override yet.
- **(If chat is enabled) No conversation memory** — each question is
  handled independently; follow-ups like *"and last quarter?"* won't have
  context, and won't remember the previous chart.

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
