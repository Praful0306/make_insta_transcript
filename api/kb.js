// Knowledge base API. One endpoint, POST { action, ... }.
// Headers: x-neon-url (always), x-groq-key (for action "step"), and optionally the user's own
// Neon file storage (x-neon-s3-*) for thumbnails.
// Nothing is stored on this server: all data goes to the user's own Neon project.
import { db, header, readBody, send, HttpError } from "./_db.js";
import { storageFrom, storeThumbnail, resolveThumbnail } from "./_storage.js";
import { translate, extract, verify, applyFix, quoteFound, tsToSec } from "./_extract.js";

const CHUNK_SEC = 180;     // YouTube: about 3 minutes of speech per part (fits Groq free-tier limits)
const CHUNK_CHARS = 3500;  // Instagram / caption-less text: split long transcripts by sentences

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ ok: false, error: "Use POST." }); }
  const body = readBody(req);
  try {
    const q = await db(req);
    const fn = ACTIONS[body.action];
    if (!fn) throw new HttpError(400, "Unknown action.");
    return res.status(200).json({ ok: true, ...(await fn(q, body, req)) });
  } catch (e) { return send(res, e); }
}

const int = v => { const n = parseInt(v, 10); if (!Number.isFinite(n)) throw new HttpError(400, "Missing id."); return n; };
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const isEnglish = lang => /^(en|eng|english)([-_ ].*)?$/i.test(String(lang || "").trim());

/* ---------- trader detection ---------- */
const normName = s => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function findOrCreateTrader(q, { platform, handle, displayName, accountUrl, traderId }) {
  handle = clip(handle, 200).replace(/^@/, "").trim() || "unknown";
  const acc = (await q(`SELECT a.id, a.trader_id, t.name FROM accounts a JOIN traders t ON t.id=a.trader_id WHERE a.platform=$1 AND a.handle=$2`, [platform, handle]))[0];
  if (acc && !traderId) {
    if (displayName) await q(`UPDATE accounts SET display_name=$1, url=COALESCE($2,url) WHERE id=$3`, [clip(displayName, 200), accountUrl || null, acc.id]);
    return { traderId: acc.trader_id, traderName: acc.name, newTrader: false, matchedBy: "account" };
  }
  let target = null, matchedBy = "";
  if (traderId) {
    target = (await q(`SELECT id, name FROM traders WHERE id=$1`, [int(traderId)]))[0];
    if (!target) throw new HttpError(400, "That trader no longer exists.");
    matchedBy = "chosen";
  } else {
    const all = await q(`SELECT id, name FROM traders`);
    const cand = normName(`${displayName} ${handle}`) + " " + normName(handle).replace(/ /g, "");
    const hits = all.filter(t => {
      const n = normName(t.name);
      if (n && (n === normName(displayName) || n === normName(handle))) return true;
      const toks = n.split(" ").filter(x => x.length >= 3);
      return toks.length >= 2 && toks.every(x => cand.includes(x));
    });
    if (hits.length === 1) { target = hits[0]; matchedBy = "name"; }
  }
  let newTrader = false;
  if (!target) {
    target = (await q(`INSERT INTO traders(name) VALUES($1) RETURNING id, name`, [clip(displayName || handle, 200)]))[0];
    newTrader = true; matchedBy = "new";
  }
  if (acc) await q(`UPDATE accounts SET trader_id=$1 WHERE id=$2`, [target.id, acc.id]);
  else await q(`INSERT INTO accounts(trader_id, platform, handle, display_name, url) VALUES($1,$2,$3,$4,$5) ON CONFLICT (platform, handle) DO UPDATE SET trader_id=EXCLUDED.trader_id`,
    [target.id, platform, handle, clip(displayName, 200) || null, accountUrl || null]);
  return { traderId: target.id, traderName: target.name, newTrader, matchedBy };
}

/* ---------- splitting into parts ---------- */
export const stamp = sec => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return "[" + (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(s).padStart(2, "0") + "]";
};

export function chunkSegments(segments) {
  const out = [];
  let cur = null;
  for (const s of segments) {
    const text = String(s.text || "").trim();
    if (!text) continue;
    if (!cur || s.start - cur.start >= CHUNK_SEC) { cur = { start: s.start, end: s.end, lines: [] }; out.push(cur); }
    cur.lines.push(`${stamp(s.start)} ${text}`);
    cur.end = s.end;
  }
  return out.map(c => ({ start: c.start, end: c.end, text: c.lines.join("\n") }));
}

export function chunkText(text) {
  text = String(text || "").trim();
  if (text.length <= CHUNK_CHARS) return text ? [text] : [];
  const sentences = text.match(/[^.!?।\n]+[.!?।]*\s*|\n+/g) || [text];
  const out = []; let cur = "";
  for (const s of sentences) {
    if (cur.length + s.length > CHUNK_CHARS && cur.trim()) { out.push(cur.trim()); cur = ""; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function chunkList(q, sourceId) {
  return q(`SELECT id, idx, status FROM chunks WHERE source_id=$1 ORDER BY idx`, [sourceId]);
}

/* ---------- rule rows ---------- */
async function insertRule(q, ids, ord, r, { found, verified, note }) {
  await q(`INSERT INTO rules(trader_id, source_id, chunk_id, ord, category, concept, title, rule, explanation, conditions, entry, stop_loss, target,
             invalidation, timeframe, instruments, indicators, ambiguities, related, quote, timestamp_sec, quote_found, verified, review_note)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20,$21,$22,$23,$24)`,
    [ids.trader, ids.source, ids.chunk, ord, r.category, r.concept, r.title, r.rule, r.explanation, JSON.stringify(r.conditions), r.entry, r.stop_loss,
     r.target, r.invalidation, r.timeframe, r.instruments, JSON.stringify(r.indicators), JSON.stringify(r.ambiguities), JSON.stringify(r.related),
     r.quote, tsToSec(r.timestamp), found, verified, note || null]);
}

const rowToRule = x => ({
  title: x.title, category: x.category, concept: x.concept, rule: x.rule, explanation: x.explanation, conditions: x.conditions || [],
  entry: x.entry, stop_loss: x.stop_loss, target: x.target, invalidation: x.invalidation, timeframe: x.timeframe, instruments: x.instruments,
  indicators: x.indicators || [], ambiguities: x.ambiguities || [], related: x.related || [], quote: x.quote,
  timestamp: x.timestamp_sec != null ? stamp(x.timestamp_sec).slice(1, -1) : "",
});

/* ---------- actions ---------- */
const ACTIONS = {
  async init(q) {
    const [c] = await q(`SELECT (SELECT count(*) FROM traders)::int AS traders, (SELECT count(*) FROM sources)::int AS sources, (SELECT count(*) FROM rules)::int AS rules`);
    return c;
  },

  async traders(q) {
    const traders = await q(`
      SELECT t.id, t.name, t.created_at,
        (SELECT count(*) FROM sources s WHERE s.trader_id=t.id)::int AS sources,
        (SELECT count(*) FROM rules r WHERE r.trader_id=t.id)::int AS rules,
        (SELECT count(*) FROM rules r WHERE r.trader_id=t.id AND NOT r.verified)::int AS flagged,
        (SELECT max(s.created_at) FROM sources s WHERE s.trader_id=t.id) AS updated,
        COALESCE((SELECT json_agg(json_build_object('platform',a.platform,'handle',a.handle,'display_name',a.display_name,'url',a.url) ORDER BY a.platform, a.handle)
                  FROM accounts a WHERE a.trader_id=t.id), '[]'::json) AS accounts
      FROM traders t ORDER BY lower(t.name)`);
    return { traders };
  },

  async trader(q, b, req) {
    const id = int(b.id);
    const trader = (await q(`SELECT id, name, created_at FROM traders WHERE id=$1`, [id]))[0];
    if (!trader) throw new HttpError(404, "Trader not found.");
    const accounts = await q(`SELECT id, platform, handle, display_name, url FROM accounts WHERE trader_id=$1 ORDER BY platform, handle`, [id]);
    const sources = await q(`
      SELECT s.id, s.platform, s.url, s.title, s.caption, s.language, s.duration_sec, s.thumbnail, s.transcript, s.english, s.status, s.created_at,
        (SELECT count(*) FROM chunks c WHERE c.source_id=s.id)::int AS parts,
        (SELECT count(*) FROM chunks c WHERE c.source_id=s.id AND c.status='done')::int AS parts_done,
        (SELECT string_agg(DISTINCT c.error, ' ') FROM chunks c WHERE c.source_id=s.id AND c.error IS NOT NULL) AS notes
      FROM sources s WHERE s.trader_id=$1 ORDER BY s.created_at`, [id]);
    const store = storageFrom(req);
    for (const s of sources) s.thumbnail = await resolveThumbnail(store, s.thumbnail);
    const rules = await q(`SELECT r.* FROM rules r JOIN sources s ON s.id=r.source_id WHERE r.trader_id=$1 ORDER BY s.created_at, r.chunk_id, r.ord, r.id`, [id]);
    return { trader, accounts, sources, rules };
  },

  // Save one transcribed source and split it into parts for extraction.
  async ingest(q, b, req) {
    const platform = b.platform === "youtube" ? "youtube" : b.platform === "instagram" ? "instagram" : null;
    if (!platform) throw new HttpError(400, "Unknown platform.");
    const url = clip(b.url, 500);
    if (!/^https:\/\/www\.(instagram\.com\/(reel|p|tv)\/[A-Za-z0-9_-]+\/|youtube\.com\/watch\?v=[A-Za-z0-9_-]{6,})$/.test(url)) throw new HttpError(400, "That link isn't an Instagram reel or YouTube video.");

    const existing = (await q(`SELECT s.id, s.trader_id, t.name FROM sources s JOIN traders t ON t.id=s.trader_id WHERE s.url=$1`, [url]))[0];
    if (existing && !b.replace) {
      return { existing: true, sourceId: existing.id, traderId: existing.trader_id, traderName: existing.name, newTrader: false, chunks: await chunkList(q, existing.id) };
    }
    if (existing) await q(`DELETE FROM sources WHERE id=$1`, [existing.id]);

    const language = clip(b.language, 60);
    let parts;
    let transcript, english = "";
    if (platform === "youtube") {
      const segs = (Array.isArray(b.segments) ? b.segments : []).map(s => ({ start: +s.start || 0, end: +s.end || 0, text: clip(s.text, 2000) }));
      parts = chunkSegments(segs).map(c => ({ ...c, english: isEnglish(language) ? c.text : null }));
      transcript = parts.map(p => p.text).join("\n");
      if (isEnglish(language)) english = transcript;
    } else {
      transcript = clip(b.transcript, 400000).trim();
      english = clip(b.english, 400000).trim() || (isEnglish(language) ? transcript : "");
      // The Make scenario already returns a full English translation, so parts are made from it.
      parts = chunkText(english || transcript).map(t => ({ start: null, end: null, text: t, english: english ? t : null }));
    }
    if (!parts.length) throw new HttpError(422, "No speech was found in this video, so there is nothing to extract.");

    const who = await findOrCreateTrader(q, { platform, handle: b.handle, displayName: b.displayName, accountUrl: b.accountUrl, traderId: b.traderId });
    // If the user added their own Neon file storage, keep the image in their bucket instead of a large/expiring inline value.
    const thumbnail = await storeThumbnail(storageFrom(req), clip(b.thumbnail, 400000));
    const src = (await q(`INSERT INTO sources(trader_id, platform, url, title, caption, language, duration_sec, thumbnail, transcript, english, status)
                          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'processing') RETURNING id`,
      [who.traderId, platform, url, clip(b.title, 300), clip(b.caption, 5000), language, +b.duration || null, thumbnail, transcript, english]))[0];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      await q(`INSERT INTO chunks(source_id, idx, start_sec, end_sec, original, english, status) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [src.id, i, p.start, p.end, p.text, p.english, p.english ? "translated" : "pending"]);
    }
    return { existing: false, sourceId: src.id, ...who, chunks: await chunkList(q, src.id) };
  },

  // Run one step on one part: translate → extract → verify. The page calls this repeatedly.
  async step(q, b, req) {
    const key = header(req, "x-groq-key");
    const id = int(b.chunkId);
    const c = (await q(`SELECT c.*, s.trader_id, s.title, s.language, t.name AS trader FROM chunks c JOIN sources s ON s.id=c.source_id JOIN traders t ON t.id=s.trader_id WHERE c.id=$1`, [id]))[0];
    if (!c) throw new HttpError(404, "Part not found.");
    const ids = { trader: c.trader_id, source: c.source_id, chunk: c.id };
    const usage = {};
    try {
      if (c.status === "pending") {
        const t = await translate(key, c.original, c.language);
        await q(`UPDATE chunks SET english=$1, status='translated', error=NULL WHERE id=$2`, [t.english, id]);
        Object.assign(usage, t.usage);
        return { status: "translated", usage };
      }
      if (c.status === "translated") {
        const x = await extract(key, { trader: c.trader, title: c.title, english: c.english });
        await q(`DELETE FROM rules WHERE chunk_id=$1`, [id]);
        let ord = 0;
        for (const r of x.rules) {
          await insertRule(q, ids, ord++, r, { found: quoteFound(r.quote, c.english), verified: false, note: "Waiting for verification." });
        }
        const next = x.rules.length ? "extracted" : "done";
        await q(`UPDATE chunks SET status=$1, error=$2 WHERE id=$3`, [next, x.rules.length ? null : (x.noRulesReason || "No trading rules stated in this part.").slice(0, 500), id]);
        return { status: next, rules: x.rules.length, usage: x.usage };
      }
      if (c.status === "extracted") {
        const rows = await q(`SELECT * FROM rules WHERE chunk_id=$1 ORDER BY ord, id`, [id]);
        const v = await verify(key, { english: c.english, rules: rows.map(rowToRule) });
        let flagged = 0, added = 0;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const chk = v.checks.find(k => +k.n === i + 1);
          const problems = chk && Array.isArray(chk.problems) ? chk.problems.map(String).filter(Boolean) : [];
          const { rule, changed } = applyFix(rowToRule(row), chk && chk.fix);
          const found = quoteFound(rule.quote, c.english);
          const ok = !!(chk && chk.supported === true) && !problems.length && !changed.length && found;
          const notes = [];
          if (!chk) notes.push("The verification pass did not return a result for this rule.");
          if (problems.length) notes.push("Checker found: " + problems.join(" | "));
          if (changed.length) notes.push("Corrected by checker: " + changed.join(", ") + ".");
          if (!found) notes.push("The quote could not be found word for word in the transcript.");
          if (!ok) flagged++;
          await q(`DELETE FROM rules WHERE id=$1`, [row.id]);
          await insertRule(q, ids, row.ord, rule, { found, verified: ok, note: notes.join(" ") || null });
        }
        let ord = rows.length;
        for (const r of v.missed) {
          await insertRule(q, ids, ord++, r, { found: quoteFound(r.quote, c.english), verified: false, note: "Added by the completeness check. Please review." });
          added++; flagged++;
        }
        await q(`UPDATE chunks SET status='done', error=NULL WHERE id=$1`, [id]);
        return { status: "done", flagged, added, usage: v.usage };
      }
      return { status: c.status };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      await q(`UPDATE chunks SET error=$1 WHERE id=$2`, [String(e.message || e).slice(0, 500), id]);
      throw new HttpError(502, String(e.message || e), { retryAfter: 3 });
    }
  },

  async finish(q, b) {
    const id = int(b.sourceId);
    const [s] = await q(`SELECT platform, language FROM sources WHERE id=$1`, [id]);
    if (!s) throw new HttpError(404, "Source not found.");
    const [c] = await q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status='done')::int AS done,
                         string_agg(COALESCE(english, ''), E'\n' ORDER BY idx) AS english FROM chunks WHERE source_id=$1`, [id]);
    const status = c.n && c.done === c.n ? "done" : "partial";
    if (s.platform === "youtube" && !isEnglish(s.language)) await q(`UPDATE sources SET english=$1, status=$2 WHERE id=$3`, [c.english || "", status, id]);
    else await q(`UPDATE sources SET status=$1 WHERE id=$2`, [status, id]);
    const [r] = await q(`SELECT count(*)::int AS rules, count(*) FILTER (WHERE NOT verified)::int AS flagged FROM rules WHERE source_id=$1`, [id]);
    return { status, ...r };
  },

  async reprocess(q, b) {
    const id = int(b.sourceId);
    await q(`DELETE FROM rules WHERE source_id=$1`, [id]);
    await q(`UPDATE chunks SET status=CASE WHEN english IS NULL THEN 'pending' ELSE 'translated' END, error=NULL WHERE source_id=$1`, [id]);
    await q(`UPDATE sources SET status='processing' WHERE id=$1`, [id]);
    return { sourceId: id, chunks: await chunkList(q, id) };
  },

  async rename(q, b) {
    const name = clip(b.name, 200).trim();
    if (!name) throw new HttpError(400, "Name can't be empty.");
    await q(`UPDATE traders SET name=$1 WHERE id=$2`, [name, int(b.traderId)]);
    return {};
  },

  // Same person, two trader pages (e.g. Instagram handle and YouTube channel): move everything into one.
  async merge(q, b) {
    const from = int(b.fromId), into = int(b.intoId);
    if (from === into) throw new HttpError(400, "Pick a different trader.");
    if (!(await q(`SELECT 1 FROM traders WHERE id=$1`, [into])).length) throw new HttpError(404, "Trader not found.");
    await q(`UPDATE accounts SET trader_id=$1 WHERE trader_id=$2`, [into, from]);
    await q(`UPDATE sources SET trader_id=$1 WHERE trader_id=$2`, [into, from]);
    await q(`UPDATE rules SET trader_id=$1 WHERE trader_id=$2`, [into, from]);
    await q(`DELETE FROM traders WHERE id=$1`, [from]);
    return { traderId: into };
  },

  async deleteSource(q, b) { await q(`DELETE FROM sources WHERE id=$1`, [int(b.sourceId)]); return {}; },
  async deleteTrader(q, b) { await q(`DELETE FROM traders WHERE id=$1`, [int(b.traderId)]); return {}; },
};
