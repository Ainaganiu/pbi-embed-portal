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

If chat is enabled, a question flows: browser captures the live report state
(active page, filters, and each visual's own data) -> server -> a small model
call picks how to answer -> one of three pipelines (read the screen, write and
run DAX, or help author a measure) -> the answer streams back over SSE with
progress stages, and any chart is built from the result rows in code and drawn
with d3 in IBCS notation. Identical repeat questions on the query path are
served from an in-memory cache.

Each report can also be synced against its semantic model from `/admin`,
which reads the tables, columns, measures, format strings and relationships
straight from Power BI. Those are merged with the descriptions typed in admin
into one card the AI is given, so it works from exact names rather than
remembered ones — and the sync reports anything your notes mention that the
model does not actually contain. Where the tenant has a Fabric-capable
workspace and the service principal has been granted Fabric API permissions
(`Dataset.Read.All` / `SemanticModel.Read.All`), the sync also reads each
measure's and calculated column's real DAX definition, so the AI writes
queries grounded in the model's actual formulas rather than only its names
and types. This is best-effort — a workspace without Fabric capacity, or a
service principal without those permissions, still gets a successful sync
with everything except the real DAX.

All configuration — Power BI credentials, the report registry (including each
report's data-model description used to generate DAX), the LLM provider/key,
and portal branding — lives in Postgres and is edited through `/admin`, gated
behind a single admin login. Secrets (the Power BI client secret and the LLM
API key) are encrypted at rest.

## Project structure

```
server.js                 # Express app: public routes, session wiring, router mounting
lib/db.js                  # Postgres pool + schema migration
lib/settings.js             # Settings/reports data layer (cached, encrypts secrets)
lib/auth.js                  # Password hashing + admin lookup + requireAdmin middleware
lib/crypto.js                 # AES-256-GCM encrypt/decrypt for secrets
lib/powerbi.js                 # AAD token cache, GenerateToken, executeQueries
lib/llm/                        # Pluggable LLM adapters (anthropic, openai, deepseek, gemini)
lib/budgets.js                   # Every size and token cap, in one place
lib/route.js                      # Model router + regex fallback
lib/errors.js                      # Failure -> message the user can act on
lib/starters.js                     # Report-specific opening questions
lib/modelMetadata.js                 # Reads the semantic model via DAX INFO functions
lib/modelCard.js                      # Merges that with the admin's descriptions
lib/modelDefinition.js                # Reads real measure/column DAX via the Fabric API
lib/chartChoice.js                   # Rows -> chart type and spec
lib/chatHelpers.js                    # Shared chat helpers: history sanitising, report context, code-fence stripping
lib/daxSkills.js                       # DAX authoring rules and per-pattern skills fed to prompts
lib/daxLint.js                          # Mechanical DAX repairs and grounding checks before/after execution
lib/llmCache.js                          # Exact-match cache for repeat query-path answers
lib/answer/{screen,query,authoring}.js    # The three answer pipelines
lib/answer/{state,dax}.js                  # Shared: report-state rendering, DAX generation
routes/chat.js                              # POST /api/chat: the streaming front door
routes/auth.js                               # /api/auth: status, setup, login, logout
routes/admin.js                               # /api/admin: settings, test-powerbi, reports CRUD
public/                                        # index.html/app.js, charts.js, chartGeometry.js, login.html/js, admin.html/js, style.css
scripts/seed.js                                 # One-time DB seed (run manually if needed)
render.yaml                                      # Render Blueprint (web service + Postgres)
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
- **(If chat is enabled) Chat cost scales with the page.** The screen path
  sends every visual's data to the model on every question. A dense page
  costs materially more per question than a sparse one. The caps are all in
  `lib/budgets.js`.

## Roadmap (post-MVP)

- [ ] Multi-tenant / per-client admin accounts and report visibility
- [ ] RLS-aware embed tokens per client
- [ ] Auto-refresh embed tokens before they expire
- [ ] Usage analytics (which reports get viewed, by whom)
- [x] Validate generated DAX against the schema before execution
- [x] Let users pick/override the chart type (bar, line, pie, table)
- [x] Add short-term conversation memory to the chat
- [ ] Support additional chart types beyond bar/line (e.g. stacked, %)
