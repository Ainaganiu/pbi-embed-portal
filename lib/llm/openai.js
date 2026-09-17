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
  // OpenRouter accepts a `reasoning` control that other OpenAI-compatible
  // endpoints would reject, so only send it there.
  //
  // The default is off, and stays off, because most calls here don't benefit:
  // summarising a page of visuals is reading, not deducing, and a reasoning
  // model will happily spend its entire token budget thinking and return
  // nothing. Measured on this model: 9.6s with reasoning vs 4.2s without, for
  // an answer of the same length.
  //
  // But a few calls genuinely are deduction — writing a query that has to line
  // up with entities on screen, or reconciling screen figures against queried
  // ones — and there a few seconds of thinking buys a correct answer instead
  // of a plausible one. Those callers pass `reasoning: "low"`, which is the
  // smallest budget OpenRouter exposes; there is no wall-clock setting, so
  // effort is the closest available proxy for "spend a little time on this".
  const supportsReasoning = /openrouter\.ai/i.test(baseUrl);

  function reasoningFor(effort) {
    if (!supportsReasoning) return {};
    if (!effort) return { reasoning: { enabled: false } };
    return { reasoning: { effort } };
  }

  return {
    // Streaming variant, used where the answer is plain prose. The wait is
    // dominated by the model, so showing text as it arrives is the difference
    // between a blank pause and a response that starts almost immediately.
    async completeStream({ system, messages, maxTokens, reasoning }, onDelta) {
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
          ...reasoningFor(reasoning),
          stream: true,
        }),
      });

      if (!res.ok) {
        throw new Error(`${name}: ${res.status} ${await readErrorBody(res)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let full = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line; a frame can straddle
        // chunk boundaries, so keep the trailing partial in the buffer.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
            if (delta) {
              full += delta;
              onDelta(delta);
            }
          } catch {
            // Ignore keep-alives and any frame that isn't a completion chunk.
          }
        }
      }

      if (!full.trim()) {
        throw new Error(`${name}: empty streamed response`);
      }
      return full;
    },

    async complete({ system, messages, json, maxTokens, reasoning }) {
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
          ...reasoningFor(reasoning),
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
          const spent = data?.usage?.completion_tokens_details?.reasoning_tokens;
          throw new Error(
            `${name}: hit the token limit before returning any answer` +
              (spent ? ` (${spent} tokens went to reasoning)` : "") +
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
