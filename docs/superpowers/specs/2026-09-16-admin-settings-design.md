# Admin settings & branding — design

## Context

The portal currently configures Power BI credentials, report registry, and
LLM settings entirely through `.env` and two static files
(`config/reports.js`, `config/schema.js`), edited by hand and requiring a
redeploy for every change. The user wants to self-serve this instead: sign
into an admin area on the deployed portal and configure Power BI IDs, LLM
settings, report registry (including a per-report data-model description for
the AI), and basic branding (name/logo/accent color) — without touching code
or redeploying. This is a single-admin tool, not multi-tenant: one login
configures the one portal that all viewers see.

## Architecture

**Database**: a Render Postgres instance (small/free tier) holds all
previously-static config. Three tables:

```sql
CREATE TABLE admin_users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- singleton row
  portal_name TEXT NOT NULL DEFAULT 'Reports Portal',
  logo_data_uri TEXT,
  accent_color TEXT NOT NULL DEFAULT '#3b5bfd',
  pbi_tenant_id TEXT,
  pbi_client_id TEXT,
  pbi_client_secret_encrypted TEXT,
  llm_provider TEXT NOT NULL DEFAULT 'anthropic',
  llm_api_key_encrypted TEXT,
  llm_model TEXT,
  llm_api_base TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  dataset_id TEXT,
  schema_description TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`server.js` stops reading Power BI/LLM config from `process.env` and
`config/*.js`. `lib/powerbi.js` and `lib/llm/index.js` instead read from a
`lib/settings.js` module that loads the `settings` + `reports` rows into an
in-memory cache, invalidated whenever an admin save happens (no polling —
just a cache-bust on write). Remaining env vars, all bootstrap-only:
`DATABASE_URL`, `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `PORT`.

**Secrets**: `pbi_client_secret` and `llm_api_key` are AES-256-GCM encrypted
(`lib/crypto.js`) with a key derived from `SETTINGS_ENCRYPTION_KEY` before
being written to Postgres. The admin API never returns the decrypted value —
`GET /api/admin/settings` reports `pbiClientSecretSet: boolean` /
`llmApiKeySet: boolean` instead of the value itself. Submitting an empty
field on save means "leave unchanged"; a non-empty value replaces it.

**Config migration**: `config/reports.js` and `config/schema.js` are
deleted. A one-time seed (`scripts/seed.js`, run manually once against the
new DB) inserts the existing `sample-report` placeholder as an editable row,
so nothing is silently lost.

## Auth flow

- `GET /api/auth/status` — reports whether any admin exists yet and whether
  the current session is logged in.
- If `admin_users` is empty, `/login` renders a **"Create admin account"**
  form (`POST /api/auth/setup { username, password }`) instead of a login
  form — one-time bootstrap, not baked into env vars.
- Once an admin exists, `/login` is a normal form
  (`POST /api/auth/login { username, password }`), verified with bcrypt,
  setting an `express-session` cookie (in-memory store — acceptable for a
  single admin on a single instance; documented limitation that a restart
  logs the admin out).
- `POST /api/auth/logout` clears the session.
- `/admin` (the settings page) and every `/api/admin/*` route require a
  valid session; anything else redirects to `/login`.
- The public portal (`/`, `/api/reports`, `/api/embed-token/:id`,
  `/api/chat`, `/api/branding`) stays fully unauthenticated, unchanged in
  spirit from today — login only gates the config surface.

## Admin UI (`/admin`)

Single page, four independently-saved sections:

1. **Branding** — portal name, logo upload (resized/capped client-side to
   ~200KB before base64 upload), accent color picker. `PUT
   /api/admin/settings` (branding fields). Reflected live on `/` via a new
   `GET /api/branding` endpoint the portal fetches on load, applying name +
   logo + accent color (as a CSS custom property) — so anonymous viewers see
   the brand without ever touching `/admin`.
2. **Power BI** — tenant ID, client ID, client secret (masked once set), and
   a **"Test connection"** button hitting `POST /api/admin/test-powerbi`,
   which attempts an AAD token fetch with the currently-saved (or
   just-typed, unsaved) credentials and reports success/failure inline.
3. **AI Chat** — provider dropdown (anthropic/openai/deepseek/gemini), API
   key (masked once set), optional model/base URL overrides.
4. **Reports** — table of reports with add/edit/delete
   (`GET/POST/PUT/DELETE /api/admin/reports[/:id]`): name, workspace ID,
   report ID, dataset ID, and a textarea for the **schema description** —
   the plain-English description of that dashboard's tables/columns/measures
   the AI uses to write DAX for it (replacing the old hardcoded
   `config/schema.js`).

## Error handling

- Postgres unreachable at boot: server still starts; admin and public API
  routes that need settings return `503 { error: "settings database
  unavailable" }` instead of crashing or hanging.
- Fresh/empty DB: public portal shows the same "not configured yet" empty
  state it already has today — nothing breaks before `/admin` has been used.
- Admin routes without a valid session: `401` with a redirect hint the
  frontend follows to `/login`.

## Testing plan

Run locally against a real Postgres (a local instance or the same Render
Postgres instance used in production). Verify: bootstrap admin creation,
login/logout, branding round-trip (upload a logo, confirm it renders on
`/`), the Power BI test-connection button (both success and failure paths),
add/edit/delete on the reports table, and that `/api/embed-token/:id` and
`/api/chat` correctly read Power BI/LLM config from the DB instead of env
vars. Re-run a Playwright screenshot pass (as was done for the chat panel
redesign) to confirm the new `/login` and `/admin` pages render and behave
correctly, plus that branding shows up on the public portal.

## Out of scope

Multi-tenancy (multiple isolated orgs/admins), SSO, per-viewer report
visibility, RLS, embed-token auto-refresh, DAX validation, chart-type
override, conversation memory — all unchanged from the original MVP's
"Known limitations."
