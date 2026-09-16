// Adapter for the Anthropic Messages API.

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function makeAnthropicProvider({ defaultBaseUrl, defaultModel }) {
  const baseUrl = process.env.LLM_API_BASE || defaultBaseUrl;
  const model = process.env.LLM_MODEL || defaultModel;
  const apiKey = process.env.LLM_API_KEY;

  return {
    async complete({ system, messages, json, maxTokens = 1024 }) {
      // Anthropic doesn't have a strict JSON-mode flag; nudge it in the
      // system prompt instead when JSON output is required.
      const systemPrompt = json
        ? `${system}\n\nRespond with ONLY valid JSON. No markdown fences, no prose outside the JSON object.`
        : system;

      const res = await fetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          // The system prompt (dataset schema description) is identical
          // across every question asked about the same report — cache it
          // so repeat requests only pay full input-token cost once per
          // ~5 minute cache window instead of on every call.
          system: [
            { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
          ],
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        throw new Error(`anthropic: ${res.status} ${await readErrorBody(res)}`);
      }

      const data = await res.json();
      const text = data?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error("anthropic: unexpected response shape");
      }
      return text;
    },
  };
}

module.exports = { makeAnthropicProvider };
