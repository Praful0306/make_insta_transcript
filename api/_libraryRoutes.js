// HTTP routes for the paid library (/api/v1/library/*) and customer accounts (/api/v1/account/*).
// No CORS headers on purpose: the site calls these from its own origin, and AI tools are not browsers.
import { HttpError, send, readBody } from "./_db.js";
import { parseFilters, listTraders, getTrader, listRules, listConcepts, knowledge, knowledgeMarkdown } from "./_knowledge.js";
import { firebaseConfigured } from "./_firebase.js";
import {
  LIMITS, PLAN, libraryConfigured, libraryDb, identify, entitlementOf, gate, reserveRules, refundRules,
  createKey, listKeys, revokeKey, usageToday, exportAccount, deleteAccount,
} from "./_library.js";

const NOTICE = "Educational material taken from the traders' own public videos, with their exact words and links. It is not financial advice and comes with no promise of results. For your own use only: do not copy, resell or republish it.";
const planInfo = () => ({
  id: PLAN, name: "Builder", price_inr_month: process.env.LIB_PRICE_INR ? +process.env.LIB_PRICE_INR : null,
  checkout_open: process.env.CHECKOUT_OPEN === "1", limits: LIMITS,
});
const active = e => !!e && (e.status === "active" || e.status === "cancelled") && new Date(e.period_end) > new Date();

// Browsers that block third-party storage break Firebase popups when the sign-in handler lives on firebaseapp.com.
// With FIREBASE_AUTH_SAME_ORIGIN=1 the handler is served from this site (see the /__/auth rewrite in vercel.json).
const sameOrigin = req => process.env.FIREBASE_AUTH_SAME_ORIGIN === "1" ? String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim().toLowerCase() || null : null;
export function authConfig(req, res) {
  const p = process.env.FIREBASE_PROJECT_ID, k = process.env.FIREBASE_API_KEY, d = process.env.FIREBASE_AUTH_DOMAIN;
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ login_ready: !!(p && k && d), library_open: libraryConfigured(), firebase: p && k && d ? { projectId: p, apiKey: k, authDomain: sameOrigin(req) || d } : null, plan: planInfo() });
}

export async function libraryRoute(req, res, u, path) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); throw new HttpError(405, "This API is read-only. Use GET."); }
    const [a, b] = path;
    if (!a) return res.status(200).json({
      name: "Trader knowledge base: library (paid)", readOnly: true, notice: NOTICE, plan: planInfo(),
      auth: "Send your personal API key in the x-api-key header. Create one in the site under Library after subscribing.",
      endpoints: ["GET /api/v1/library/traders", "GET /api/v1/library/concepts", "GET /api/v1/library/rules", "GET /api/v1/library/knowledge", "GET /api/v1/library/traders/{id}"],
    });
    const f = parseFilters(u.searchParams);
    const { q, who, rulesUsed, owner } = await gate(req);                  // from here on the caller is a signed-in, paying member within limits
    let reserved = 0, served = 0, out;
    try {
      const reserve = async want => (reserved = owner ? want : await reserveRules(q, who.uid, rulesUsed, want));
      if (a === "traders" && !b) out = await listTraders(q);
      else if (a === "concepts" && !b) out = await listConcepts(q, f);
      else if (a === "traders" && b) {
        const id = parseInt(b, 10); if (!Number.isFinite(id)) throw new HttpError(400, "The id must be a number.");
        const room = await reserve(f.limit);
        out = await getTrader(q, id, f, false, { limit: room, offset: f.offset }); served = out.rules.length;
      } else if (a === "rules" && !b) {
        const room = await reserve(f.limit);
        out = await listRules(q, { ...f, limit: room }); served = out.rules.length;
      } else if (a === "knowledge" && !b) {
        const room = await reserve(f.limit);
        const k = await knowledge(q, f, { limit: room, offset: f.offset }); served = k.rule_count;
        if ((u.searchParams.get("format") || "").toLowerCase() === "markdown") {
          if (!owner) setQuota(res, rulesUsed + served);
          res.setHeader("Content-Type", "text/markdown; charset=utf-8");
          return res.status(200).send(knowledgeMarkdown(k, f) + `\n\n---\n${NOTICE}\n`);
        }
        out = k;
      } else throw new HttpError(404, "Unknown endpoint. See /api/v1/library.");
    } finally { if (!owner) await refundRules(q, who.uid, reserved, served).catch(() => {}); }
    if (!owner) setQuota(res, rulesUsed + served);
    return res.status(200).json({ ...out, notice: NOTICE });
  } catch (e) { return send(res, e); }
}
function setQuota(res, rulesToday) {
  res.setHeader("X-Quota-Rules-Today", String(rulesToday));
  res.setHeader("X-Quota-Rules-Limit", String(LIMITS.rulesPerDay));
  res.setHeader("X-Quota-Requests-Limit", String(LIMITS.reqPerDay));
}

export async function accountRoute(req, res, u, path) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const q = await libraryDb();
    const who = await identify(req, q, { tokenOnly: true });
    const [a, b] = path;
    const m = req.method;
    if (!a && m === "GET") {
      const e = await entitlementOf(q, who.uid);
      return res.status(200).json({
        email: who.email, plan: planInfo(),
        entitlement: e ? { plan: e.plan, status: e.status, period_end: e.period_end, active: active(e), owner: e.source === "owner" } : null,
        usage: await usageToday(q, who.uid), keys: await listKeys(q, who.uid),
      });
    }
    if (a === "keys" && !b && m === "POST") {
      const e = await entitlementOf(q, who.uid);
      if (!active(e)) throw new HttpError(402, "API keys are for paying members.", { code: "payment_required" });
      return res.status(201).json(await createKey(q, who.uid, readBody(req).label));
    }
    if (a === "keys" && b && m === "DELETE") { await revokeKey(q, who.uid, parseInt(b, 10) || 0); return res.status(200).json({ ok: true }); }
    if (a === "export" && m === "GET") {
      res.setHeader("Content-Disposition", 'attachment; filename="my-data.json"');
      return res.status(200).json(await exportAccount(q, who.uid));
    }
    if (!a && m === "DELETE") {
      if (readBody(req).confirm !== "DELETE") throw new HttpError(400, 'Send {"confirm":"DELETE"} to confirm.');
      await deleteAccount(q, who.uid, who.email);
      return res.status(200).json({ ok: true, deleted: true });
    }
    throw new HttpError(404, "Unknown endpoint.");
  } catch (e) { return send(res, e); }
}
