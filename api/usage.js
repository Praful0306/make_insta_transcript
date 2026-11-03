// Returns live monthly usage for each Apify token the user sends.
// Header: x-apify-keys = comma-separated tokens. Tokens are not stored or logged.

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST." });
  }
  const raw = String(req.headers["x-apify-keys"] || "");
  const keys = raw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 3);
  if (!keys.length) return res.status(400).json({ ok: false, error: "No Apify tokens sent." });

  const apify = await Promise.all(keys.map(async (key, i) => {
    try {
      const r = await fetch("https://api.apify.com/v2/users/me/limits", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (r.status === 401 || r.status === 403) return { index: i, ok: false, error: "Token rejected" };
      if (!r.ok) return { index: i, ok: false, error: `Apify error ${r.status}` };
      const d = (await r.json()).data || {};
      return {
        index: i,
        ok: true,
        usedUsd: Number(d.current?.monthlyUsageUsd ?? 0),
        limitUsd: Number(d.limits?.maxMonthlyUsageUsd ?? 0),
        cycleStart: d.monthlyUsageCycle?.startAt || null,
        cycleEnd: d.monthlyUsageCycle?.endAt || null,
      };
    } catch {
      return { index: i, ok: false, error: "Couldn't reach Apify" };
    }
  }));

  return res.status(200).json({ ok: true, apify });
}
