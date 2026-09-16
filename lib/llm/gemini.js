// Adapter for Google's Gemini generateContent API.

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

function makeGeminiProvider({ defaultBaseUrl, defaultModel }) {
  const baseUrl = process.env.LLM_API_BASE || defaultBaseUrl;
  const model = process.env.LLM_MODEL || defaultModel;
  const apiKey = process.env.LLM_API_KEY;

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
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error("gemini: unexpected response shape");
      }
      return text;
    },
  };
}

module.exports = { makeGeminiProvider };
