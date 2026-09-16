// Adapter for Google's Gemini generateContent API.

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function makeGeminiProvider({ apiKey, model, baseUrl }) {
  return {
    async complete({ system, messages, json, maxTokens }) {
      // Gemini's roles are "user"/"model"; flatten our simple message list.
      const contents = messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

      const generationConfig = {
        ...(json ? { responseMimeType: "application/json" } : {}),
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
      };

      const res = await fetch(
        `${baseUrl}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
          }),
        }
      );

      if (!res.ok) {
        throw new Error(`gemini: ${res.status} ${await readErrorBody(res)}`);
      }

      const data = await res.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join("");
      if (typeof text !== "string" || !text.trim()) {
        if (candidate?.finishReason === "MAX_TOKENS") {
          throw new Error(
            "gemini: hit the token limit before returning any answer. " +
              "Raise the token cap, or pick a non-reasoning model."
          );
        }
        throw new Error(`gemini: empty response (finishReason: ${candidate?.finishReason ?? "unknown"})`);
      }
      return text;
    },
  };
}

module.exports = { makeGeminiProvider };
