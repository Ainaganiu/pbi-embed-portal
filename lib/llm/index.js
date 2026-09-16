// Provider registry for the optional AI chat panel. Selects an adapter based
// on LLM_PROVIDER, or returns null (chat disabled) if no API key is set.

const { makeOpenAiCompatible } = require("./openai");
const { makeAnthropicProvider } = require("./anthropic");
const { makeGeminiProvider } = require("./gemini");

const DEFAULTS = {
  openai: {
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
  },
  deepseek: {
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
  },
  anthropic: {
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-5",
  },
  gemini: {
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
  },
};

let cachedProvider; // undefined = not yet resolved, null = disabled

/**
 * Returns the configured LLM provider, or null if the chat panel is
 * disabled (no LLM_API_KEY set). Result is cached — set env vars before
 * the server starts.
 */
function getProvider() {
  if (cachedProvider !== undefined) return cachedProvider;

  if (!process.env.LLM_API_KEY) {
    cachedProvider = null;
    return cachedProvider;
  }

  const name = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
  const config = DEFAULTS[name];
  if (!config) {
    throw new Error(
      `Unknown LLM_PROVIDER "${name}". Supported: ${Object.keys(DEFAULTS).join(", ")}`
    );
  }

  if (name === "anthropic") {
    cachedProvider = makeAnthropicProvider(config);
  } else if (name === "gemini") {
    cachedProvider = makeGeminiProvider(config);
  } else {
    // openai + deepseek share the same OpenAI-compatible wire format
    cachedProvider = makeOpenAiCompatible({ name, ...config });
  }

  return cachedProvider;
}

module.exports = { getProvider };
