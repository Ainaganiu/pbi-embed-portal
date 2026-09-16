// Thin wrapper around Azure AD client-credentials auth + the Power BI REST
// API. Everything here uses Node's global fetch — no SDK dependency.
// Credentials are passed in explicitly (from the DB-backed settings) rather
// than read from process.env, since they're now admin-configurable at
// runtime.

const AAD_TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
const PBI_API_BASE = "https://api.powerbi.com/v1.0/myorg";
const PBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";

let cachedToken = null; // { accessToken, expiresAt }

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

/**
 * Power BI wraps the useful part of a query error inside nested JSON. Pull out
 * the human-readable message so callers — and the user — see "The syntax for
 * 'Current' is incorrect" rather than a wall of envelope.
 */
function extractPbiMessage(body) {
  try {
    const parsed = JSON.parse(body);
    const details = parsed?.error?.["pbi.error"]?.details;
    const message = details?.find((d) => d.code === "DetailsMessage")?.detail?.value;
    if (message) {
      // The engine echoes the whole query back after the message; the message
      // itself is the part worth showing.
      return String(message).split(" (DEFINE")[0].split(" (EVALUATE")[0].trim();
    }
    if (parsed?.error?.message) return parsed.error.message;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body;
}

function clearTokenCache() {
  cachedToken = null;
}

/**
 * Fetches (and caches) an AAD access token for the given service principal,
 * via the OAuth2 client-credentials flow. Cached until ~60s before expiry.
 * Pass skipCache to force a fresh request (used by the "test connection"
 * admin action, so it reflects credentials that may not be saved yet).
 */
async function getAadToken({ tenantId, clientId, clientSecret, skipCache = false }) {
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Power BI service principal is not configured (tenant ID / client ID / client secret)"
    );
  }

  if (!skipCache && cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: PBI_SCOPE,
  });

  const res = await fetch(AAD_TOKEN_URL(tenantId), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    throw new Error(`AAD token request failed: ${res.status} ${await readErrorBody(res)}`);
  }

  const json = await res.json();
  const accessToken = json.access_token;
  if (!skipCache) {
    cachedToken = { accessToken, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  }
  return accessToken;
}

async function pbiFetch(credentials, path, options = {}) {
  const token = await getAadToken(credentials);
  const res = await fetch(`${PBI_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(
      `Power BI API ${options.method || "GET"} ${path} failed: ${res.status} ${extractPbiMessage(await readErrorBody(res))}`
    );
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Generates a short-lived View embed token for a report, and returns its
 * embed URL alongside it.
 */
async function generateEmbedToken(credentials, { workspaceId, reportId }) {
  if (!workspaceId || !reportId) {
    throw new Error("generateEmbedToken requires workspaceId and reportId");
  }

  const report = await pbiFetch(credentials, `/groups/${workspaceId}/reports/${reportId}`);

  const tokenResponse = await pbiFetch(
    credentials,
    `/groups/${workspaceId}/reports/${reportId}/GenerateToken`,
    {
      method: "POST",
      body: JSON.stringify({ accessLevel: "View" }),
    }
  );

  return {
    accessToken: tokenResponse.token,
    embedUrl: report.embedUrl,
    reportId,
    expiry: tokenResponse.expiration,
  };
}

/**
 * Runs a DAX query against a dataset via executeQueries, and returns the
 * flattened result rows.
 */
async function executeQuery(credentials, { workspaceId, datasetId, dax }) {
  if (!workspaceId || !datasetId) {
    throw new Error("executeQuery requires workspaceId and datasetId");
  }
  if (!dax) {
    throw new Error("executeQuery requires a dax query string");
  }

  const result = await pbiFetch(
    credentials,
    `/groups/${workspaceId}/datasets/${datasetId}/executeQueries`,
    {
      method: "POST",
      body: JSON.stringify({
        queries: [{ query: dax }],
        serializerSettings: { includeNulls: true },
      }),
    }
  );

  return result?.results?.[0]?.tables?.[0]?.rows ?? [];
}

/**
 * Lists workspaces (groups) the service principal is a member of.
 * Used by the admin UI's "browse Power BI" picker.
 */
async function listWorkspaces(credentials) {
  const result = await pbiFetch(credentials, "/groups?$top=200");
  return (result?.value ?? []).map((w) => ({ id: w.id, name: w.name }));
}

/**
 * Lists reports in a workspace, including each report's associated
 * dataset ID (null for reports with no bound dataset, e.g. some
 * paginated reports).
 */
async function listReports(credentials, workspaceId) {
  if (!workspaceId) {
    throw new Error("listReports requires workspaceId");
  }
  const result = await pbiFetch(credentials, `/groups/${workspaceId}/reports`);
  return (result?.value ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    datasetId: r.datasetId || null,
  }));
}

module.exports = {
  getAadToken,
  clearTokenCache,
  generateEmbedToken,
  executeQuery,
  listWorkspaces,
  listReports,
};
