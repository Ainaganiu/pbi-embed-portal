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
      const choice = data?.choices?.[0];
      const text = choice?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        // Reasoning models spend completion tokens on hidden reasoning before
        // emitting any content, so a cap that's fine for a normal model can
        // truncate them to nothing. Say so explicitly rather than reporting a
        // vague shape mismatch.
        if (choice?.finish_reason === "length") {
          const reasoning = data?.usage?.completion_tokens_details?.reasoning_tokens;
          throw new Error(
            `${name}: hit the token limit before returning any answer` +
              (reasoning ? ` (${reasoning} tokens went to reasoning)` : "") +
              `. Raise the token cap, or pick a non-reasoning model.`
          );
        }
        throw new Error(
          `${name}: empty response (finish_reason: ${choice?.finish_reason ?? "unknown"})`
        );
      }
      return text;
    },
  };
}

module.exports = { makeOpenAiCompatible };
