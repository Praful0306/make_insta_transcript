// Groq chat helper. The user's key arrives in the x-groq-key header and is used for this call only.
import { HttpError } from "./_db.js";
import { chatLocal } from "./_llm.js";

export const MODEL = "openai/gpt-oss-120b";
const FREE_TPM = 8000; // Groq free tier tokens-per-minute for gpt-oss-120b; input + max output must fit

const estTokens = s => Math.ceil(String(s).length / 3.2);

// Rate-limit headers Groq sends on every reply. The page uses them to space calls per key.
// Names follow Groq's OpenAI-compatible headers; any that are missing simply come back null.
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const limitsFrom = h => ({
  limitReq: num(h.get("x-ratelimit-limit-requests")), remainReq: num(h.get("x-ratelimit-remaining-requests")), resetReq: h.get("x-ratelimit-reset-requests"),
  limitTok: num(h.get("x-ratelimit-limit-tokens")), remainTok: num(h.get("x-ratelimit-remaining-tokens")), resetTok: h.get("x-ratelimit-reset-tokens"),
});
// "Please try again in 7m12.5s" / "1h2m3s" / "850ms" -> seconds
export function secondsFrom(text) {
  const m = /(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?/.exec(String(text || ""));
  if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) + (+m[4] || 0) / 1000;
}

export async function chatJson(key, system, user, { effort = "medium", maxOut = 6000 } = {}) {
  if (key && typeof key === "object" && key.llm) return chatLocal(key.llm, system, user, { maxOut });   // the user's own AI server (Colab)
  if (!key) throw new HttpError(400, "Add your Groq API key in API keys.", { code: "keys" });
  const input = estTokens(system) + estTokens(user) + 50;
  const max = Math.max(1500, Math.min(maxOut, FREE_TPM - input - 200));
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      reasoning_effort: effort,
      response_format: { type: "json_object" },
      max_completion_tokens: max,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new HttpError(400, "Groq rejected this API key. Check it in API keys.", { code: "groqkey" });
  if (r.status === 429) {
    let msg = ""; try { msg = JSON.parse(text).error.message || ""; } catch {}
    const tryIn = secondsFrom((/try again in\s+([0-9a-z.]+)/i.exec(msg) || [])[1]);
    const ra = parseFloat(r.headers.get("retry-after")) || tryIn || 20;
    // A per-day limit (tokens or requests per day) won't clear in a minute: tell the page so it stops using this key for now.
    const daily = /per day|\((TPD|RPD|ASD)\)/i.test(msg) || ra > 600;
    throw new HttpError(429, daily ? "This Groq key reached its daily limit." : "Groq rate limit reached on this key.",
      { retryAfter: Math.min(86400, Math.ceil(ra)), daily, limits: limitsFrom(r.headers) });
  }
  if (r.status === 413) throw new HttpError(413, "This part is too long for the Groq free tier's per-minute limit.", { retryAfter: 60 });
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error.message; } catch {}
    if (/json_validate_failed|failed to generate json/i.test(msg)) throw new HttpError(502, "Groq returned broken JSON. Retrying usually fixes it.", { retryAfter: 2 });
    throw new HttpError(502, "Groq error: " + msg);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new HttpError(502, "Groq returned an unreadable reply.", { retryAfter: 2 }); }
  const choice = data.choices && data.choices[0];
  if (choice && choice.finish_reason === "length") throw new HttpError(502, "Groq ran out of output space for this part.", { retryAfter: 2 });
  // reserved = what Groq counts against the per-minute token limit (input + the output we allow)
  const usage = { ...(data.usage || {}), reserved: input + max, limits: limitsFrom(r.headers) };
  try { return { json: JSON.parse(choice.message.content), usage }; }
  catch { throw new HttpError(502, "Groq returned broken JSON. Retrying usually fixes it.", { retryAfter: 2 }); }
}
