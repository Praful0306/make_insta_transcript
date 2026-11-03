// Groq chat helper. The user's key arrives in the x-groq-key header and is used for this call only.
import { HttpError } from "./_db.js";

export const MODEL = "openai/gpt-oss-120b";
const FREE_TPM = 8000; // Groq free tier tokens-per-minute for gpt-oss-120b; input + max output must fit

const estTokens = s => Math.ceil(String(s).length / 3.2);

export async function chatJson(key, system, user, { effort = "medium", maxOut = 6000 } = {}) {
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
    const ra = parseFloat(r.headers.get("retry-after")) || 20;
    throw new HttpError(429, "Groq rate limit reached on this key.", { retryAfter: Math.min(120, Math.ceil(ra)) });
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
  try { return { json: JSON.parse(choice.message.content), usage: data.usage || {} }; }
  catch { throw new HttpError(502, "Groq returned broken JSON. Retrying usually fixes it.", { retryAfter: 2 }); }
}
