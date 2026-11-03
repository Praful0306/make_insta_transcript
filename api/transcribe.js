// Vercel serverless function: forwards one reel URL to the Make webhook.
// The webhook URL and the optional app password live in Vercel env vars,
// so nothing secret is shipped to the browser.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST." });
  }

  const password = process.env.APP_PASSWORD;
  if (password && req.headers["x-app-password"] !== password) {
    return res.status(401).json({ ok: false, error: "Wrong or missing app password." });
  }

  const hook = process.env.MAKE_WEBHOOK_URL;
  if (!hook) {
    return res.status(500).json({ ok: false, error: "MAKE_WEBHOOK_URL is not set in Vercel." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const url = String((body && body.url) || "").trim();
  if (!/^https:\/\/www\.instagram\.com\/(reel|p|tv)\/[A-Za-z0-9_-]+\/?$/.test(url)) {
    return res.status(400).json({ ok: false, error: "That doesn't look like an Instagram reel link." });
  }

  try {
    const r = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return res.status(502).json({
        ok: false,
        error: "Make didn't return a result. The reel may be private, deleted, or a photo post, or Make timed out.",
      });
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ ok: false, error: "Couldn't reach Make. Try again in a minute." });
  }
}
