// Provider registry for the optional AI chat panel. Selects an adapter
// based on settings loaded from the DB (see lib/settings.js), or returns
// null (chat disabled) if no API key is configured.

const { makeOpenAiCompatible } = require("./openai");
const { makeAnthropicProvider } = require("./anthropic");
const { makeGeminiProvider } = require("./gemini");

const DEFAULTS = {
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-5" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
};

/**
 * Returns a provider `{ complete(...) }` built from explicit settings, or
 * null if no API key is given (chat disabled). Cheap to call per-request —
 * no network I/O happens until complete() is called.
 */
function getProvider({ provider, apiKey, model, apiBase }) {
  if (!apiKey) return null;

  const name = (provider || "anthropic").toLowerCase();
  const defaults = DEFAULTS[name];
  if (!defaults) {
    throw new Error(`Unknown LLM provider "${name}". Supported: ${Object.keys(DEFAULTS).join(", ")}`);
  }

  const config = {
    apiKey,
    model: model || defaults.model,
    baseUrl: apiBase || defaults.baseUrl,
  };

  if (name === "anthropic") return makeAnthropicProvider(config);
  if (name === "gemini") return makeGeminiProvider(config);
  return makeOpenAiCompatible({ name, ...config });
}

module.exports = { getProvider };
