// Public, read-only knowledge-base API: /api/v1/*
// Auth: the caller's own Neon connection string in the x-neon-url header (never stored or logged).
// The server has no data of its own; every request reads from the caller's database.
import { db, send, HttpError } from "../_db.js";
import { parseFilters, listTraders, getTrader, getSource, listRules, listConcepts, knowledge, knowledgeMarkdown } from "../_knowledge.js";
import { openapi } from "../_openapi.js";

const origin = req => `${(req.headers["x-forwarded-proto"] || "https").split(",")[0]}://${req.headers["x-forwarded-host"] || req.headers.host}`;
const intId = s => { const n = parseInt(s, 10); if (!Number.isFinite(n) || String(n) !== s) throw new HttpError(400, "The id must be a number."); return n; };

export default async function handler(req, res) {
  // Browser-based tools may call this too. There are no cookies; the credential is the header.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "x-neon-url, content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") { res.setHeader("Allow", "GET, OPTIONS"); return res.status(405).json({ ok: false, error: "This API is read-only. Use GET." }); }

  const u = new URL(req.url, "http://x");
  const path = u.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b] = path;
  try {
    if (!a) return res.status(200).json({
      name: "Trader knowledge base API", version: "1.0.0", readOnly: true,
      auth: "Send your own Neon connection string in the x-neon-url header.",
      docs: { openapi: origin(req) + "/api/v1/openapi.json", llms: origin(req) + "/llms.txt", skill: origin(req) + "/skill/SKILL.md" },
      endpoints: ["GET /api/v1/traders", "GET /api/v1/traders/{id}", "GET /api/v1/sources/{id}", "GET /api/v1/rules", "GET /api/v1/concepts", "GET /api/v1/knowledge"],
    });
    if (a === "openapi.json" && !b) return res.status(200).json(openapi(origin(req)));

    const f = parseFilters(u.searchParams);
    if (!req.headers["x-neon-url"]) throw new HttpError(401, "Send your own Neon connection string in the x-neon-url header. See /api/v1/openapi.json.", { code: "auth" });
    const q = await db(req, { readOnly: true });
    if (a === "traders" && !b) return res.status(200).json(await listTraders(q));
    if (a === "traders" && b) return res.status(200).json(await getTrader(q, intId(b), f, u.searchParams.get("include") === "transcripts"));
    if (a === "sources" && b) return res.status(200).json(await getSource(q, intId(b)));
    if (a === "rules" && !b) return res.status(200).json(await listRules(q, f));
    if (a === "concepts" && !b) return res.status(200).json(await listConcepts(q, f));
    if (a === "knowledge" && !b) {
      const k = await knowledge(q, f);
      if ((u.searchParams.get("format") || "").toLowerCase() === "markdown") {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        return res.status(200).send(knowledgeMarkdown(k, f));
      }
      return res.status(200).json(k);
    }
    throw new HttpError(404, "Unknown endpoint. See /api/v1/openapi.json.");
  } catch (e) { return send(res, e); }
}
