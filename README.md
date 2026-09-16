# Power BI Embedded Portal

A web app that embeds Power BI reports for external users via app-owns-data
(service principal) auth — no Power BI license needed to view — plus an
optional AI chat panel that answers questions about the data and draws a
quick chart alongside the answer. Everything (Power BI credentials, the LLM
provider, the report registry, and portal branding) is configured at runtime
through an admin dashboard — no code edits or redeploys needed to change
config.

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
Chart.js chart. Identical repeat questions are served from an in-memory cache
instead of re-querying the LLM/Power BI.

All configuration — Power BI credentials, the report registry (including each
report's data-model description used to generate DAX), the LLM provider/key,
and portal branding — lives in Postgres and is edited through `/admin`, gated
behind a single admin login. Secrets (the Power BI client secret and the LLM
API key) are encrypted at rest.

## Project structure

```
server.js               # Express app: public routes, session wiring, router mounting
lib/db.js                # Postgres pool + schema migration
lib/settings.js           # Settings/reports data layer (cached, encrypts secrets)
lib/auth.js                # Password hashing + admin lookup + requireAdmin middleware
lib/crypto.js               # AES-256-GCM encrypt/decrypt for secrets
lib/powerbi.js               # AAD token cache, GenerateToken, executeQueries
lib/llm/                      # Pluggable LLM adapters (anthropic, openai, deepseek, gemini)
lib/llmCache.js                # Exact-match cache for /api/chat responses
routes/auth.js                  # /api/auth: status, setup (bootstrap), login, logout
routes/admin.js                  # /api/admin: settings, test-powerbi, reports CRUD
public/                            # index.html/app.js (portal), login.html/js, admin.html/js
scripts/seed.js                     # One-time DB seed (run manually if needed)
render.yaml                          # Render Blueprint (web service + Postgres)
```

## Setup

### 1. Prerequisites

- A Power BI workspace assigned to a Pro/Premium/Fabric capacity, with your
  report(s) published to it.
- An Azure AD app registration (service principal) with a client secret.
- "Allow service principals to use Power BI APIs" enabled in the Power BI
  admin portal.
- The service principal added as a member of the workspace(s).
- A Postgres database (Render Postgres, or any Postgres instance).

### 2. Configure

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`, `SESSION_SECRET`, and `SETTINGS_ENCRYPTION_KEY` (any
long random strings for the latter two — `openssl rand -hex 32` works well).
That's it for required env vars — everything else is configured through the
admin UI.

Optionally set `ADMIN_USERNAME` + `ADMIN_PASSWORD` to control the admin
account from env instead of (or in addition to) the UI bootstrap — see below.

### 3. Run locally

```bash
npm install
npm start
```

Visit `http://localhost:3000/login.html`. Since no admin account exists yet,
you'll be prompted to create one — unless `ADMIN_USERNAME`/`ADMIN_PASSWORD`
are set in `.env`, in which case that account is created automatically on
boot and you can just log in. Either way, `/admin.html` lets you configure:

- **Branding** — portal name, logo, accent color (shown to every visitor,
  no login required).
- **Power BI** — tenant/client ID + client secret, with a "Test connection"
  button.
- **AI Chat** — provider (`anthropic` | `openai` | `deepseek` | `gemini`),
  API key, and optional model/base-URL overrides. Leave the API key blank to
  run as an embed-only portal.
- **Reports** — add/edit/delete reports: name, workspace ID, report ID,
  dataset ID, and a **data description for the AI** — the tables, columns,
  and measures the LLM uses to write accurate DAX for that report. A report
  only shows the chat panel once it has a dataset ID, a data description, and
  an LLM API key is set.

A `sample-report` placeholder is seeded automatically on first migration —
edit its IDs via `/admin` rather than starting from scratch.

### 4. Deploy to Render

This repo includes a `render.yaml` Blueprint (web service + Postgres).

1. Push the project to a GitHub repo.
2. In Render: **New → Blueprint** → connect the repo. Render provisions both
   the Postgres database and the web service, wiring `DATABASE_URL` and
   generating `SESSION_SECRET`/`SETTINGS_ENCRYPTION_KEY` automatically.
3. Deploy — Render gives you a public URL. Visit `/login.html` to create the
   admin account, then configure everything else via `/admin.html`.

Notes:
- The `free` Postgres plan expires after 30 days — plan to upgrade or export
  data before then if you're using it beyond evaluation.
- The `free` web service plan spins down after inactivity, so the first
  request after idle time will be slow while the instance wakes up.

## Known limitations

- **No row-level security** — the embed token grants full report access.
  Add `identities` with roles to `GenerateToken` and matching RLS roles in
  the model to scope data per user.
- **No per-user report visibility** — every visitor sees every report in
  the list; there's no concept of "this client only sees these two reports."
- **Single admin, no SSO** — one username/password account, session stored
  in-memory (a server restart logs the admin out, but doesn't affect the
  public portal). No change-password UI — set/reset it via `ADMIN_USERNAME`/
  `ADMIN_PASSWORD` env vars and restart.
- **Tokens expire** — the embed token isn't auto-refreshed, so a long-open
  tab will eventually need a page reload.
- **(If chat is enabled) No DAX validation** — generated queries run
  directly against the dataset without being checked against the schema
  first. The generated DAX is returned alongside the answer so you can spot
  check it.
- **(If chat is enabled) Chart type is chosen by the LLM, not the user.**
- **(If chat is enabled) No conversation memory** — each question is
  handled independently.

## Roadmap (post-MVP)

- [ ] Multi-tenant / per-client admin accounts and report visibility
- [ ] RLS-aware embed tokens per client
- [ ] Auto-refresh embed tokens before they expire
- [ ] Usage analytics (which reports get viewed, by whom)
- [ ] Validate generated DAX against the schema before execution
- [ ] Let users pick/override the chart type (bar, line, pie, table)
- [ ] Add short-term conversation memory to the chat
- [ ] Support additional chart types beyond bar/line (e.g. stacked, %)
