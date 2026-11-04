// The paid library: our own hosted knowledge base, open only to paying customers.
//
// SAFETY RULES (every one is enforced here, on the server, never in the page):
//  1. Fail closed. If anything in the checks below is missing or breaks, nothing is read and nothing is sent.
//  2. The order is fixed: identify -> check payment -> check limits -> only then read the library tables.
//     A caller who hasn't paid never causes a single library row to be read.
//  3. Access comes from a row in lib_entitlements written by a trusted server path (the payment webhook or the
//     owner's grant script), never from anything the browser or an AI tool claims.
//  4. Paid access runs until period_end, including after cancellation. Expired = locked again on the next call.
//  5. AI tools use personal API keys. Keys are random, stored only as a SHA-256 hash, shown once, revocable,
//     and capped at MAX_KEYS per customer. A key stops working the moment its owner's access ends.
//  6. Daily and per-minute limits are counted in the database with atomic statements, so parallel calls can't skip them.
//  7. The library serves rules, short quotes and source links only. Never full transcripts.
//  8. Only metadata is ever logged (who, which endpoint, how many rules). Never keys, tokens or rule text.
import { createHash, randomBytes } from "node:crypto";
import { db, header, HttpError } from "./_db.js";
import { verifyFirebaseToken, firebaseConfigured } from "./_firebase.js";

const envInt = (name, def) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n > 0 ? n : def; };
export const LIMITS = {
  reqPerDay: envInt("LIB_REQ_PER_DAY", 100),      // API calls per customer per UTC day (resets 00:00 UTC = 05:30 IST)
  rulesPerDay: envInt("LIB_RULES_PER_DAY", 500),  // rules served per customer per UTC day
  reqPerMin: envInt("LIB_REQ_PER_MIN", 15),       // calls per customer per minute
  rulesPerCall: envInt("LIB_RULES_PER_CALL", 200),// rules in one response
  maxKeys: envInt("LIB_MAX_KEYS", 3),             // active API keys per customer
};
export const PLAN = "builder";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS lib_customers(
     uid text PRIMARY KEY, email text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS lib_entitlements(
     uid text PRIMARY KEY REFERENCES lib_customers(uid) ON DELETE CASCADE,
     plan text NOT NULL, status text NOT NULL CHECK (status IN ('active','cancelled','expired')),
     period_end timestamptz NOT NULL, source text NOT NULL, provider_ref text,
     updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS lib_pending_grants(
     email text PRIMARY KEY, plan text NOT NULL, period_end timestamptz NOT NULL, source text NOT NULL, provider_ref text)`,
  `CREATE TABLE IF NOT EXISTS lib_api_keys(
     id serial PRIMARY KEY, uid text NOT NULL REFERENCES lib_customers(uid) ON DELETE CASCADE,
     prefix text NOT NULL, key_hash text NOT NULL UNIQUE, label text,
     created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS lib_usage_day(
     uid text NOT NULL REFERENCES lib_customers(uid) ON DELETE CASCADE, day date NOT NULL,
     requests int NOT NULL DEFAULT 0, rules int NOT NULL DEFAULT 0, PRIMARY KEY(uid, day))`,
  `CREATE TABLE IF NOT EXISTS lib_usage_min(
     uid text NOT NULL REFERENCES lib_customers(uid) ON DELETE CASCADE, minute timestamptz NOT NULL,
     requests int NOT NULL DEFAULT 0, PRIMARY KEY(uid, minute))`,
];
const readyFor = new Set();

export const libraryConfigured = () => !!(process.env.LIBRARY_DATABASE_URL && firebaseConfigured());

// Opens the library database (server-side secret) and makes sure the account tables exist.
export async function libraryDb() {
  if (!libraryConfigured()) throw new HttpError(503, "The library isn't open yet.", { code: "closed" });
  const url = process.env.LIBRARY_DATABASE_URL;
  const q = await db({ headers: {} }, { url });
  if (!readyFor.has(url)) { for (const s of SCHEMA) await q(s); readyFor.add(url); }
  return q;
}

const sha = s => createHash("sha256").update(s).digest("hex");
const KEY_RE = /^kbk_[A-Za-z0-9_-]{43}$/;
const unauthorized = (m = "Sign in, or send your API key in the x-api-key header.") => new HttpError(401, m, { code: "unauthorized" });

/* ---------- who is calling ---------- */
// tokenOnly: account pages need a signed-in person, so API keys are not accepted there.
export async function identify(req, q, { tokenOnly = false } = {}) {
  const k = header(req, "x-api-key");
  if (k) {
    if (tokenOnly) throw unauthorized("Sign in to manage your account.");
    if (!KEY_RE.test(k)) throw unauthorized("That API key isn't valid.");
    const row = (await q(`SELECT id, uid FROM lib_api_keys WHERE key_hash=$1 AND revoked_at IS NULL`, [sha(k)]))[0];
    if (!row) throw unauthorized("That API key isn't valid or was revoked.");
    await q(`UPDATE lib_api_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [row.id]);
    return { uid: row.uid, via: "key" };
  }
  const m = /^Bearer\s+(\S+)$/i.exec(header(req, "authorization"));
  if (!m) throw unauthorized();
  let t;
  try { t = await verifyFirebaseToken(m[1]); } catch { throw unauthorized("Your sign-in has expired. Sign in again."); }
  if (!t.email || !t.emailVerified) throw new HttpError(403, "Verify your email address first. We sent you a link.", { code: "email_unverified" });
  await q(`INSERT INTO lib_customers(uid, email) VALUES($1,$2) ON CONFLICT (uid) DO UPDATE SET email=EXCLUDED.email`, [t.uid, t.email]);
  // a grant made for this email before they first signed in
  const g = (await q(`DELETE FROM lib_pending_grants WHERE email=$1 RETURNING plan, period_end, source, provider_ref`, [t.email]))[0];
  if (g) await setEntitlement(q, t.uid, { plan: g.plan, periodEnd: g.period_end, source: g.source, ref: g.provider_ref });
  // Owner: a verified email listed in OWNER_EMAILS always has access (set only in Vercel, never in the page).
  const owners = (process.env.OWNER_EMAILS || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
  if (owners.includes(t.email)) await q(`INSERT INTO lib_entitlements(uid, plan, status, period_end, source) VALUES($1,$2,'active', now() + interval '400 days','owner')
      ON CONFLICT (uid) DO UPDATE SET status='active', period_end=now() + interval '400 days', source='owner', updated_at=now()
      WHERE lib_entitlements.period_end < now() + interval '30 days'`, [t.uid, PLAN]);
  return { uid: t.uid, email: t.email, via: "token" };
}

/* ---------- payment ---------- */
export async function entitlementOf(q, uid) {
  return (await q(`SELECT plan, status, period_end FROM lib_entitlements WHERE uid=$1`, [uid]))[0] || null;
}
export async function assertPaid(q, uid) {
  const e = (await q(`SELECT plan FROM lib_entitlements WHERE uid=$1 AND status IN ('active','cancelled') AND period_end > now()`, [uid]))[0];
  if (!e) throw new HttpError(402, "The library is for paying members. Subscribe to unlock it. No library data is sent without an active plan.", { code: "payment_required" });
  return e;
}
// Called only by trusted server code: the payment webhook (later) or scripts/grant-access.mjs.
export async function setEntitlement(q, uid, { plan = PLAN, status = "active", periodEnd, source, ref = null }) {
  await q(`INSERT INTO lib_entitlements(uid, plan, status, period_end, source, provider_ref) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT (uid) DO UPDATE SET plan=EXCLUDED.plan, status=EXCLUDED.status, period_end=EXCLUDED.period_end, source=EXCLUDED.source, provider_ref=EXCLUDED.provider_ref, updated_at=now()`,
    [uid, plan, status, periodEnd, source, ref]);
}
export async function grantByEmail(q, email, { plan = PLAN, periodEnd, source = "manual", ref = null }) {
  email = String(email).trim().toLowerCase();
  const c = (await q(`SELECT uid FROM lib_customers WHERE email=$1`, [email]))[0];
  if (c) { await setEntitlement(q, c.uid, { plan, periodEnd, source, ref }); return "granted"; }
  await q(`INSERT INTO lib_pending_grants(email, plan, period_end, source, provider_ref) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT (email) DO UPDATE SET plan=EXCLUDED.plan, period_end=EXCLUDED.period_end, source=EXCLUDED.source, provider_ref=EXCLUDED.provider_ref`, [email, plan, periodEnd, source, ref]);
  return "pending";
}

/* ---------- limits ---------- */
const secondsToNextMinute = () => 60 - new Date().getUTCSeconds();
const secondsToNextDay = () => { const n = new Date(); return Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000); };
const limited = (m, retryAfter, code) => new HttpError(429, m, { code, retryAfter });
const DAY = `(now() AT TIME ZONE 'UTC')::date`;

// Counts one call. Returns today's usage so far.
export async function spendRequest(q, uid) {
  if (Math.random() < 0.02) await q(`DELETE FROM lib_usage_min WHERE minute < now() - interval '1 hour'`);
  const m = await q(`INSERT INTO lib_usage_min(uid, minute, requests) VALUES($1, date_trunc('minute', now()), 1)
                     ON CONFLICT (uid, minute) DO UPDATE SET requests = lib_usage_min.requests + 1 WHERE lib_usage_min.requests < $2 RETURNING requests`, [uid, LIMITS.reqPerMin]);
  if (!m.length) throw limited(`Too many calls this minute (limit ${LIMITS.reqPerMin}). Wait a moment.`, secondsToNextMinute(), "rate_limited");
  const d = await q(`INSERT INTO lib_usage_day(uid, day, requests) VALUES($1, ${DAY}, 1)
                     ON CONFLICT (uid, day) DO UPDATE SET requests = lib_usage_day.requests + 1 WHERE lib_usage_day.requests < $2 RETURNING requests, rules`, [uid, LIMITS.reqPerDay]);
  if (!d.length) throw limited(`Daily limit reached (${LIMITS.reqPerDay} calls a day). It resets at 00:00 UTC.`, secondsToNextDay(), "daily_limit");
  return d[0];
}
// Reserves room for up to `want` rules. Returns how many may be served (never more than the daily allowance).
export async function reserveRules(q, uid, used, want) {
  const room = Math.min(want, LIMITS.rulesPerCall, LIMITS.rulesPerDay - used);
  if (room <= 0) throw limited(`Daily limit reached (${LIMITS.rulesPerDay} rules a day). It resets at 00:00 UTC.`, secondsToNextDay(), "daily_limit");
  const r = await q(`UPDATE lib_usage_day SET rules = rules + $3 WHERE uid=$1 AND day=${DAY} AND rules + $3 <= $2 RETURNING rules`, [uid, LIMITS.rulesPerDay, room]);
  if (!r.length) throw limited(`Daily limit reached (${LIMITS.rulesPerDay} rules a day). It resets at 00:00 UTC.`, secondsToNextDay(), "daily_limit");
  return room;
}
export async function refundRules(q, uid, reserved, served) {
  if (reserved > served) await q(`UPDATE lib_usage_day SET rules = GREATEST(0, rules - $2) WHERE uid=$1 AND day=${DAY}`, [uid, reserved - served]);
}

// The one door into the library. Nothing past this call runs for someone who hasn't paid.
export async function gate(req) {
  const q = await libraryDb();                       // fails closed when the library isn't configured
  const who = await identify(req, q);                // 401 / 403
  await assertPaid(q, who.uid);                      // 402
  const today = await spendRequest(q, who.uid);      // 429
  return { q, who, rulesUsed: today.rules };
}

/* ---------- API keys ---------- */
export async function createKey(q, uid, label) {
  const active = (await q(`SELECT count(*)::int AS n FROM lib_api_keys WHERE uid=$1 AND revoked_at IS NULL`, [uid]))[0].n;
  if (active >= LIMITS.maxKeys) throw new HttpError(400, `You can have ${LIMITS.maxKeys} active API keys. Revoke one first.`, { code: "too_many_keys" });
  const key = "kbk_" + randomBytes(32).toString("base64url");
  const row = (await q(`INSERT INTO lib_api_keys(uid, prefix, key_hash, label) VALUES($1,$2,$3,$4) RETURNING id, prefix, label, created_at`,
    [uid, key.slice(0, 8), sha(key), String(label || "").slice(0, 60) || null]))[0];
  return { key, ...row };                            // the only time the full key exists
}
export const listKeys = (q, uid) => q(`SELECT id, prefix, label, created_at, last_used_at, (revoked_at IS NOT NULL) AS revoked FROM lib_api_keys WHERE uid=$1 ORDER BY id`, [uid]);
export async function revokeKey(q, uid, id) {
  const r = await q(`UPDATE lib_api_keys SET revoked_at=now() WHERE id=$1 AND uid=$2 AND revoked_at IS NULL RETURNING id`, [id, uid]);
  if (!r.length) throw new HttpError(404, "Key not found.");
}

/* ---------- my data: show, export, delete ---------- */
export async function usageToday(q, uid) {
  const r = (await q(`SELECT requests, rules FROM lib_usage_day WHERE uid=$1 AND day=${DAY}`, [uid]))[0];
  return { requests: r ? r.requests : 0, rules: r ? r.rules : 0, limits: LIMITS, resets_at_utc: new Date(Date.now() + secondsToNextDay() * 1000).toISOString() };
}
export async function exportAccount(q, uid) {
  const [customer] = await q(`SELECT uid, email, created_at FROM lib_customers WHERE uid=$1`, [uid]);
  return {
    exported_at: new Date().toISOString(), customer,
    entitlement: await entitlementOf(q, uid),
    api_keys: await listKeys(q, uid),                // only a short prefix is kept, never the key itself
    usage_last_30_days: await q(`SELECT day, requests, rules FROM lib_usage_day WHERE uid=$1 AND day > ${DAY} - 30 ORDER BY day`, [uid]),
  };
}
// Deletes everything we hold about this person (rows cascade from the customer record).
export async function deleteAccount(q, uid, email) {
  await q(`DELETE FROM lib_customers WHERE uid=$1`, [uid]);
  if (email) await q(`DELETE FROM lib_pending_grants WHERE email=$1`, [email]);
}
