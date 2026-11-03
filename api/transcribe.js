// Vercel serverless function. Every user brings their own:
//   x-make-webhook  Make.com webhook URL of THEIR scenario (runs on their Make account)
//   x-groq-key      Groq API key
//   x-apify-key     Apify API token
// This function only forwards { url, groqKey, apifyKey } to the user's webhook
// and returns the scenario's JSON reply. Keys are never stored or logged.

function header(req, name) {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v || "").trim();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST." });
  }

  const webhook = header(req, "x-make-webhook");
  const groqKey = header(req, "x-groq-key");
  const apifyKey = header(req, "x-apify-key");

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const url = String((body && body.url) || "").trim();

  if (!/^https:\/\/www\.instagram\.com\/(reel|p|tv)\/[A-Za-z0-9_-]+\/?$/.test(url)) {
    return res.status(400).json({ ok: false, error: "That doesn't look like an Instagram reel link." });
  }
  if (!/^https:\/\/hook\.[a-z0-9]+\.make\.com\/[A-Za-z0-9]+$/.test(webhook)) {
    return res.status(400).json({ ok: false, error: "Add your own Make.com webhook URL in API keys." });
  }
  if (!groqKey) return res.status(400).json({ ok: false, error: "Add your Groq API key in API keys." });
  if (!apifyKey) return res.status(400).json({ ok: false, error: "Add your Apify API token in API keys." });

  try {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, groqKey, apifyKey }),
    });
    const text = await r.text();
    if (r.status === 410 || r.status === 404) {
      return res.status(400).json({ ok: false, error: "Your Make webhook URL wasn't found. Check it in API keys and that the scenario still exists." });
    }
    let data;
    try { data = JSON.parse(text); } catch {
      const hint = /accepted/i.test(text)
        ? "Your Make scenario didn't reply. Make sure it's switched ON, then check its History in Make for the error (often a wrong key, or a private reel)."
        : "Your Make scenario returned something unexpected. Check its History in Make.";
      return res.status(502).json({ ok: false, error: hint });
    }
    return res.status(200).json(data);
  } catch {
    return res.status(502).json({ ok: false, error: "Couldn't reach your Make webhook. Try again in a minute." });
  }
}
