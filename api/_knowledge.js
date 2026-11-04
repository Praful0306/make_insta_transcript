// Read-only queries and formatting for the public knowledge-base API (api/v1).
// Everything here only SELECTs from the caller's own Neon database.
import { HttpError } from "./_db.js";

const NS = "Not stated";
export const MAX_RULES = 5000; // hard cap for one combined response

/* ---------- filters ---------- */
const ids = v => {
  if (!v) return null;
  const out = String(v).split(",").map(x => parseInt(x, 10)).filter(Number.isFinite);
  if (!out.length) throw new HttpError(400, "trader must be one or more numeric ids, e.g. trader=1,4.");
  return out.slice(0, 200);
};
const bool = v => (v == null || v === "" ? null : /^(1|true|yes)$/i.test(v) ? true : /^(0|false|no)$/i.test(v) ? false : null);
const num = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

export function parseFilters(params) {
  return {
    trader: ids(params.get("trader")),
    concept: (params.get("concept") || "").trim().slice(0, 200) || null,
    category: (params.get("category") || "").trim().slice(0, 100) || null,
    text: (params.get("q") || "").trim().slice(0, 200) || null,
    verified: bool(params.get("verified")),
    limit: num(params.get("limit"), 100, 1, 500),
    offset: num(params.get("offset"), 0, 0, 1e7),
  };
}

function where(f) {
  const w = [], a = [];
  // the same placeholder may be used more than once in one condition
  const add = (sql, v) => { a.push(v); w.push(sql.replaceAll("?", "$" + a.length)); };
  if (f.trader) add("r.trader_id = ANY(?::int[])", f.trader);
  if (f.concept) add("lower(r.concept) = lower(?)", f.concept);
  if (f.category) add("lower(r.category) = lower(?)", f.category);
  if (f.verified != null) add("r.verified = ?", f.verified);
  if (f.text) add("(r.title ILIKE ? OR r.rule ILIKE ? OR r.explanation ILIKE ? OR r.concept ILIKE ? OR r.quote ILIKE ?)", "%" + f.text.replace(/[\\%_]/g, m => "\\" + m) + "%");
  return { sql: w.length ? "WHERE " + w.join(" AND ") : "", args: a };
}

const RULE_SELECT = `
  SELECT r.id, r.trader_id, t.name AS trader, r.source_id, s.platform, s.url AS source_url, s.title AS source_title,
         r.category, r.concept, r.title, r.rule, r.explanation, r.conditions, r.entry, r.stop_loss, r.target,
         r.invalidation, r.timeframe, r.instruments, r.indicators, r.ambiguities, r.related,
         r.quote, r.timestamp_sec, r.quote_found, r.verified, r.review_note
  FROM rules r JOIN traders t ON t.id = r.trader_id JOIN sources s ON s.id = r.source_id`;

const link = r => (r.platform === "youtube" && r.timestamp_sec != null ? `${r.source_url}&t=${Math.floor(r.timestamp_sec)}s` : r.source_url);
const shape = r => ({
  id: r.id,
  trader: { id: r.trader_id, name: r.trader },
  source: { id: r.source_id, platform: r.platform, url: r.source_url, title: r.source_title, link: link(r), timestamp_sec: r.timestamp_sec },
  category: r.category, concept: r.concept, title: r.title, rule: r.rule, explanation: r.explanation,
  conditions: r.conditions || [], entry: r.entry, stop_loss: r.stop_loss, target: r.target, invalidation: r.invalidation,
  timeframe: r.timeframe, instruments: r.instruments, indicators: r.indicators || [], ambiguities: r.ambiguities || [], related: r.related || [],
  quote: r.quote, quote_found: r.quote_found, verified: r.verified, review_note: r.verified ? null : r.review_note,
});

/* ---------- queries ---------- */
export async function listTraders(q) {
  const traders = await q(`
    SELECT t.id, t.name, t.created_at,
      (SELECT count(*) FROM sources s WHERE s.trader_id=t.id)::int AS sources,
      (SELECT count(*) FROM rules r WHERE r.trader_id=t.id)::int AS rules,
      (SELECT count(*) FROM rules r WHERE r.trader_id=t.id AND r.verified)::int AS verified_rules,
      COALESCE((SELECT json_agg(json_build_object('platform',a.platform,'handle',a.handle,'display_name',a.display_name,'url',a.url) ORDER BY a.platform, a.handle)
                FROM accounts a WHERE a.trader_id=t.id), '[]'::json) AS accounts
    FROM traders t ORDER BY lower(t.name)`);
  return { traders };
}

export async function getTrader(q, id, f, withTranscripts, { limit = MAX_RULES, offset = 0 } = {}) {
  const trader = (await q(`SELECT id, name, created_at FROM traders WHERE id=$1`, [id]))[0];
  if (!trader) throw new HttpError(404, "Trader not found.");
  const accounts = await q(`SELECT platform, handle, display_name, url FROM accounts WHERE trader_id=$1 ORDER BY platform, handle`, [id]);
  const cols = withTranscripts ? ", s.transcript, s.english" : "";
  const sources = await q(`SELECT s.id, s.platform, s.url, s.title, s.language, s.duration_sec, s.created_at${cols} FROM sources s WHERE s.trader_id=$1 ORDER BY s.created_at`, [id]);
  const w = where({ ...f, trader: [id] });
  const rules = await q(`${RULE_SELECT} ${w.sql} ORDER BY s.created_at, r.chunk_id, r.ord, r.id LIMIT ${+limit} OFFSET ${+offset}`, w.args);
  return { trader, accounts, sources, rules: rules.map(shape) };
}

export async function getSource(q, id) {
  const s = (await q(`SELECT s.id, s.trader_id, t.name AS trader, s.platform, s.url, s.title, s.caption, s.language, s.duration_sec, s.transcript, s.english, s.created_at
                      FROM sources s JOIN traders t ON t.id=s.trader_id WHERE s.id=$1`, [id]))[0];
  if (!s) throw new HttpError(404, "Source not found.");
  return { source: s };
}

export async function listRules(q, f) {
  const w = where(f);
  const total = (await q(`SELECT count(*)::int AS n FROM rules r ${w.sql}`, w.args))[0].n;
  const rows = await q(`${RULE_SELECT} ${w.sql} ORDER BY t.name, s.created_at, r.chunk_id, r.ord, r.id LIMIT ${f.limit} OFFSET ${f.offset}`, w.args);
  return { total, limit: f.limit, offset: f.offset, rules: rows.map(shape) };
}

export async function listConcepts(q, f) {
  const w = where(f);
  const rows = await q(`
    SELECT COALESCE(NULLIF(trim(r.concept), ''), 'General') AS concept, count(*)::int AS rules,
           count(*) FILTER (WHERE r.verified)::int AS verified_rules,
           json_agg(DISTINCT jsonb_build_object('id', r.trader_id, 'name', t.name)) AS traders
    FROM rules r JOIN traders t ON t.id = r.trader_id ${w.sql}
    GROUP BY 1 ORDER BY count(*) DESC, 1`, w.args);
  return { concepts: rows };
}

// All matching rules from all (or the chosen) traders, grouped by concept so rules
// from different traders about the same idea sit together.
export async function knowledge(q, f, { limit = MAX_RULES, offset = 0 } = {}) {
  const w = where(f);
  const rows = await q(`${RULE_SELECT} ${w.sql} ORDER BY t.name, s.created_at, r.chunk_id, r.ord, r.id LIMIT ${+limit + 1} OFFSET ${+offset}`, w.args);
  const truncated = rows.length > limit;
  const rules = rows.slice(0, limit).map(shape);
  const groups = new Map();
  for (const r of rules) {
    const k = (r.concept || "").trim() || "General";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const concepts = [...groups.entries()]
    .map(([concept, rs]) => ({ concept, rules: rs.length, traders: [...new Set(rs.map(r => r.trader.name))], items: rs }))
    .sort((a, b) => b.rules - a.rules || a.concept.localeCompare(b.concept));
  const traders = [...new Map(rules.map(r => [r.trader.id, r.trader])).values()];
  return { generated: new Date().toISOString(), rule_count: rules.length, verified_count: rules.filter(r => r.verified).length, truncated, next_offset: truncated ? +offset + limit : null, traders, concepts };
}

/* ---------- markdown ---------- */
export function knowledgeMarkdown(k, f) {
  const L = [];
  L.push("# Trading knowledge base (combined)", "");
  L.push(`Generated ${k.generated.slice(0, 10)}. ${k.rule_count} rules from ${k.traders.length} trader(s): ${k.verified_count} verified against the transcript, ${k.rule_count - k.verified_count} marked NEEDS REVIEW.${k.truncated ? ` Output was cut; ask for the next page with offset=${k.next_offset}, or narrow it with trader, concept or verified.` : ""}`);
  if (f.verified === true) L.push("Only verified rules are included.");
  L.push("", "## How to use this file", "",
    "- Every rule comes only from the named trader's own words, with the exact quote and a link to the source (with a timestamp for YouTube).",
    `- "${NS}" means the trader did not say it. Do not fill those gaps with assumptions when building an indicator or strategy. Keep them as inputs the user can set.`,
    "- Rules marked NEEDS REVIEW failed an automatic check. Confirm them against the quote before coding.",
    "- Traders can disagree. Rules about the same concept are grouped together with the trader's name so you can compare, combine, or ask the user which to follow.", "");
  L.push("## Traders", "");
  k.traders.forEach(t => L.push(`- ${t.name} (id ${t.id})`));
  L.push("", "## Concepts", "");
  k.concepts.forEach(c => L.push(`- ${c.concept}: ${c.rules} rule(s) from ${c.traders.join(", ")}`));
  L.push("", "## Rules", "");
  for (const c of k.concepts) {
    L.push(`### ${c.concept}`, "");
    for (const r of c.items) {
      L.push(`#### ${r.title || "Untitled"} (${r.trader.name}) [${r.category}] ${r.verified ? "[VERIFIED]" : "[NEEDS REVIEW]"}`, "");
      if (!r.verified && r.review_note) L.push(`> Review note: ${r.review_note}`, "");
      L.push(`- Rule: ${r.rule || NS}`);
      if (r.explanation) L.push(`- Explanation: ${r.explanation}`);
      if (r.conditions.length) { L.push("- Conditions:"); r.conditions.forEach(x => L.push(`  - ${x}`)); }
      L.push(`- Entry: ${r.entry || NS}`, `- Stop loss: ${r.stop_loss || NS}`, `- Target: ${r.target || NS}`, `- Invalidation: ${r.invalidation || NS}`, `- Timeframe: ${r.timeframe || NS}`, `- Instruments: ${r.instruments || NS}`);
      L.push(`- Indicators: ${r.indicators.map(i => `${i.name} (${i.settings || NS})`).join("; ") || NS}`);
      if (r.related.length) L.push(`- Related concepts: ${r.related.join(", ")}`);
      if (r.ambiguities.length) { L.push("- Not specified by the trader:"); r.ambiguities.forEach(x => L.push(`  - ${x}`)); }
      if (r.quote) L.push(`- Exact quote: "${r.quote}"`);
      L.push(`- Source: ${r.source.title || r.source.platform}, ${r.source.link}`, "");
    }
  }
  return L.join("\n");
}
