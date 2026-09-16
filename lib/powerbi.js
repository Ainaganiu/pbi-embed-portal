// Thin wrapper around Azure AD client-credentials auth + the Power BI REST
// API. Everything here uses Node's global fetch — no SDK dependency.

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
 * Fetches (and caches) an AAD access token for the configured service
 * principal, via the OAuth2 client-credentials flow. Cached until ~60s
 * before expiry so we don't hit AAD on every request.
 */
async function getAadToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const tenantId = process.env.PBI_TENANT_ID;
  const clientId = process.env.PBI_CLIENT_ID;
  const clientSecret = process.env.PBI_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    throw new Error(
      "Power BI service principal is not configured (PBI_TENANT_ID / PBI_CLIENT_ID / PBI_CLIENT_SECRET)"
    );
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
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

async function pbiFetch(path, options = {}) {
  const token = await getAadToken();
  const res = await fetch(`${PBI_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Power BI API ${options.method || "GET"} ${path} failed: ${res.status} ${await readErrorBody(res)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Generates a short-lived View embed token for a report, and returns its
 * embed URL alongside it.
 */
async function generateEmbedToken({ workspaceId, reportId }) {
  if (!workspaceId || !reportId) {
    throw new Error("generateEmbedToken requires workspaceId and reportId");
  }

  const report = await pbiFetch(`/groups/${workspaceId}/reports/${reportId}`);

  const tokenResponse = await pbiFetch(
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
async function executeQuery({ workspaceId, datasetId, dax }) {
  if (!workspaceId || !datasetId) {
    throw new Error("executeQuery requires workspaceId and datasetId");
  }
  if (!dax) {
    throw new Error("executeQuery requires a dax query string");
  }

  const result = await pbiFetch(
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

module.exports = { getAadToken, generateEmbedToken, executeQuery };
