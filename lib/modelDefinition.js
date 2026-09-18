// lib/modelDefinition.js
//
// Real measure and calculated-column DAX, read from Fabric's Get Semantic
// Model Definition API (?format=TMSL) -- a different mechanism entirely
// from executeQueries (lib/powerbi.js), which redacts Expression
// unconditionally regardless of permissions. This requires Fabric API
// permissions (Dataset.Read.All / SemanticModel.Read.All) and a workspace
// on Fabric/Premium/PPU capacity; established by probe against a Fabric
// trial capacity before any of this was built.
//
// TMSL (requested via ?format=TMSL) returns a single model.bim JSON file --
// the documented Analysis Services tabular schema -- rather than the
// default TMDL text folder, so this needs no custom parser: just a JSON
// walk with a field whitelist.

const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
const FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1";
const AAD_TOKEN_URL = (tenantId) =>
  `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

// Deliberately separate from lib/powerbi.js's token cache -- Fabric and the
// classic Power BI REST API are different AAD resources, and caching one
// token under the other's key would silently send the wrong audience.
let cachedToken = null; // { accessToken, expiresAt }

function clearFabricTokenCache() {
  cachedToken = null;
}

async function getFabricToken({ tenantId, clientId, clientSecret }) {
  if (!tenantId || !clientId || !clientSecret) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: FABRIC_SCOPE,
  });

  let res;
  try {
    res = await fetch(AAD_TOKEN_URL(tenantId), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    console.error("[model definition] Fabric token request failed:", err.message);
    return null;
  }
  if (!res.ok) {
    console.error(`[model definition] Fabric token request rejected: ${res.status}`);
    return null;
  }

  const json = await res.json();
  if (!json.access_token) {
    console.error("[model definition] Fabric token response had no access_token");
    return null;
  }
  cachedToken = { accessToken: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cachedToken.accessToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls a Fabric long-running-operation until it succeeds, fails, or the
// ceiling is reached -- this runs synchronously inside an admin's "Sync
// from model" click, which already does several sequential DAX queries, so
// it must have a hard ceiling rather than polling forever. The ceiling is
// deliberately kept well under typical hosted-proxy request timeouts (see
// fetchModelDefinition's default), since a sync that times out at the proxy
// saves nothing at all -- worse than the feature not existing.
async function pollOperation(location, token, { pollIntervalMs, maxPollMs }) {
  const deadline = Date.now() + maxPollMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let res;
    try {
      res = await fetch(location, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      console.error("[model definition] poll request failed:", err.message);
      return null;
    }
    if (!res.ok) {
      console.error(`[model definition] poll request rejected: ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.status === "Succeeded") {
      let resultRes;
      try {
        resultRes = await fetch(`${location}/result`, { headers: { Authorization: `Bearer ${token}` } });
      } catch (err) {
        console.error("[model definition] result fetch failed:", err.message);
        return null;
      }
      if (!resultRes.ok) {
        console.error(`[model definition] result fetch rejected: ${resultRes.status}`);
        return null;
      }
      return resultRes.json();
    }
    if (json.status === "Failed") {
      console.error("[model definition] Fabric operation reported Failed");
      return null;
    }
    // "Running" / "NotStarted" -- keep polling.
  }
  console.error(`[model definition] poll exceeded ceiling of ${maxPollMs}ms`);
  return null;
}

function decodeBim(parts) {
  const part = Array.isArray(parts) ? parts.find((p) => p.path === "model.bim") : null;
  if (!part) {
    console.error("[model definition] response had no model.bim part");
    return null;
  }
  try {
    return JSON.parse(Buffer.from(part.payload, "base64").toString("utf8"));
  } catch (err) {
    console.error("[model definition] model.bim was not valid JSON:", err.message);
    return null;
  }
}

// TMSL serialises a single-line expression as a string but a multi-line one
// (e.g. any VAR ... RETURN measure) as an array, one element per line. Both
// forms are normalised to one string here so nothing downstream ever joins
// an array with a bare comma -- which is not DAX.
function normaliseExpression(raw) {
  if (Array.isArray(raw)) return raw.length ? raw.join("\n") : null;
  return typeof raw === "string" && raw ? raw : null;
}

// Only these fields ever leave this function. Everything else in the TMSL
// payload -- partitions (the full Power Query/M source, which can carry a
// local file path or connection details), dataSources, roles, perspectives
// -- is discarded right here, not merely unused by a caller downstream.
function extractWhitelist(bim) {
  const tables = bim?.model?.tables;
  if (!Array.isArray(tables)) return { measures: [], columns: [], relationships: [] };

  const measures = [];
  const columns = [];
  for (const t of tables) {
    for (const m of t.measures || []) {
      const expression = normaliseExpression(m?.expression);
      if (m?.name && expression) measures.push({ name: m.name, expression });
    }
    for (const c of t.columns || []) {
      const expression = normaliseExpression(c?.expression);
      if (c?.type === "calculated" && c?.name && expression) {
        columns.push({ name: c.name, table: t.name, expression });
      }
    }
  }

  // fromColumn/toColumn deliberately not carried past this point: nothing
  // downstream keys on them -- lib/modelMetadata.js's mergeDefinition
  // matches relationships by table pair and suppresses the overlay
  // entirely on a colliding pair rather than guessing which one a finer
  // key would apply to -- so keeping them here would be dead weight in a
  // module whose whole point is a narrow whitelist.
  const relationships = (bim?.model?.relationships || [])
    .filter((r) => r?.fromTable && r?.toTable)
    .map((r) => ({
      fromTable: r.fromTable,
      toTable: r.toTable,
      isActive: r.isActive !== false,
      crossFilteringBehavior: r.crossFilteringBehavior ?? null,
    }));

  return { measures, columns, relationships };
}

/**
 * Reads real DAX from the model's own Fabric definition. Resolves to null
 * on any failure -- no Fabric permission, a non-Fabric-capacity workspace,
 * an LRO that never completes within the ceiling, a malformed response --
 * and logs the specific cause via console.error, matching
 * fetchModelMetadata's existing contract. Never throws: a model that will
 * not describe itself this way must not take the sync down with it, since
 * the INFO.VIEW read is what actually matters for chat to keep working.
 *
 * maxPollMs defaults well under typical hosted-proxy request timeouts --
 * this call sits inside a single synchronous admin request alongside
 * several other round trips, and a proxy timeout here would save nothing
 * that was read, unlike a clean null.
 */
async function fetchModelDefinition(
  credentials,
  { workspaceId, datasetId },
  { pollIntervalMs = 5000, maxPollMs = 45_000 } = {}
) {
  if (!workspaceId || !datasetId) return null;

  try {
    const token = await getFabricToken(credentials);
    if (!token) return null;

    const url = `${FABRIC_API_BASE}/workspaces/${workspaceId}/semanticModels/${datasetId}/getDefinition?format=TMSL`;
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });

    let result;
    if (res.status === 200) {
      result = await res.json();
    } else if (res.status === 202) {
      const location = res.headers.get("Location");
      if (!location) {
        console.error("[model definition] 202 response had no Location header");
        return null;
      }
      result = await pollOperation(location, token, { pollIntervalMs, maxPollMs });
    } else {
      console.error(`[model definition] getDefinition rejected: ${res.status}`);
      return null;
    }
    if (!result) return null;

    const bim = decodeBim(result.definition?.parts);
    if (!bim) return null;
    return extractWhitelist(bim);
  } catch (err) {
    console.error("[model definition] fetch failed:", err.message);
    return null;
  }
}

module.exports = { fetchModelDefinition, clearFabricTokenCache };
