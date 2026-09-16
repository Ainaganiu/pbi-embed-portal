// Adapter for any OpenAI-compatible /chat/completions API. Used directly for
// OpenAI, and reused as-is for DeepSeek (same wire format, different base
// URL + default model).

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function makeOpenAiCompatible({ name, apiKey, model, baseUrl }) {
  return {
    async complete({ system, messages, json, maxTokens }) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: system }, ...messages],
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });

      if (!res.ok) {
        throw new Error(`${name}: ${res.status} ${await readErrorBody(res)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new Error(`${name}: unexpected response shape`);
      }
      return text;
    },
  };
}

module.exports = { makeOpenAiCompatible };
