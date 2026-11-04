// Optional "my own AI server" (for example a Google Colab notebook) used instead of Groq for translating,
// extracting and checking rules. The page sends its public tunnel address in x-llm-url.
// The server only ever calls addresses from the short list below, so this can't be used to reach other machines.
import { HttpError, header } from "./_db.js";

const HOSTS = [".trycloudflare.com", ".ngrok-free.app", ".ngrok.app", ".ngrok.dev"];
export const DEFAULT_MODEL = "qwen2.5:7b";

export function llmFrom(req) {
  const raw = header(req, "x-llm-url");
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, "The Colab address is not a valid web address. Copy it again from the notebook.", { code: "llm" }); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !HOSTS.some(h => u.hostname.endsWith(h)))
    throw new HttpError(400, "The Colab address must be an https://....trycloudflare.com (or ngrok) address, as printed by the notebook.", { code: "llm" });
  const model = String(header(req, "x-llm-model") || DEFAULT_MODEL).replace(/[^A-Za-z0-9._:\/-]/g, "").slice(0, 80) || DEFAULT_MODEL;
  return { url: u.origin, model };
}

const down = () => new HttpError(502, "The Colab server did not answer. Check that the notebook is still running, then press Retry.", { retryAfter: 8, code: "llm" });

// OpenAI-compatible chat call to the user's own server (Ollama, vLLM, llama.cpp ...). No rate limits to manage.
export async function chatLocal(llm, system, user, { maxOut = 4000 } = {}) {
  let r, text;
  try {
    r = await fetch(llm.url + "/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({
        model: llm.model, temperature: 0, stream: false, response_format: { type: "json_object" }, max_tokens: Math.min(maxOut, 4000),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    text = await r.text();
  } catch { throw down(); }
  if (r.status === 404) throw new HttpError(502, `The Colab server does not have the model "${llm.model}". Run the notebook's model cell, or fix the model name in API keys.`, { code: "llm" });
  if (!r.ok) throw down();
  let data, content;
  try { data = JSON.parse(text); content = data.choices[0].message.content; } catch { throw new HttpError(502, "The Colab server sent an unreadable reply. Retrying usually fixes it.", { retryAfter: 3, code: "llm" }); }
  if (data.choices[0].finish_reason === "length") throw new HttpError(502, "The model ran out of output space for this part. Retrying.", { retryAfter: 3, code: "llm" });
  const clean = String(content).replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  let json;
  try { json = JSON.parse(clean); } catch {
    const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
    try { json = JSON.parse(clean.slice(a, b + 1)); } catch { throw new HttpError(502, "The model returned broken JSON. Retrying usually fixes it.", { retryAfter: 3, code: "llm" }); }
  }
  return { json, usage: { ...(data.usage || {}), reserved: 0, limits: {} } };
}
