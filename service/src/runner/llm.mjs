// A minimal client for any OpenAI-compatible chat API (OpenRouter by default), so the
// model can be swapped by changing two settings. It asks for a JSON answer.

export function chatModel({ baseUrl = "https://openrouter.ai/api/v1", apiKey, model, temperature = 1.0, maxTokens = 4000, http = fetch, retries = 2 } = {}) {
  if (!model) throw new Error("LLM model is required");
  return async function complete(messages) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await http(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
          // Reasoning models (e.g. DeepSeek) can spend the whole budget thinking and return no answer:
          // ask for brief reasoning and leave room for it. Models without reasoning ignore this.
          body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, response_format: { type: "json_object" }, reasoning: { effort: "low" } }),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`model API busy: HTTP ${res.status}`);
        const body = await res.json();
        if (!res.ok) throw new Error(`model API error: ${body.error?.message ?? res.status}`);
        const text = body.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) throw new Error(`model returned no text (finish: ${body.choices?.[0]?.finish_reason ?? "?"})`);
        return { text, model: body.model ?? model, usage: body.usage ?? null };
      } catch (e) {
        lastErr = e;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    throw lastErr;
  };
}
