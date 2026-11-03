// Neon database helper. Each user brings their own Neon connection string in the
// x-neon-url header. It is used for this request only and is never stored or logged.
import { neon } from "@neondatabase/serverless";

const ready = new Set(); // connection strings whose tables already exist in this warm instance

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS traders(
     id serial PRIMARY KEY,
     name text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS accounts(
     id serial PRIMARY KEY,
     trader_id int NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
     platform text NOT NULL,
     handle text NOT NULL,
     display_name text,
     url text,
     UNIQUE(platform, handle))`,
  `CREATE TABLE IF NOT EXISTS sources(
     id serial PRIMARY KEY,
     trader_id int NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
     platform text NOT NULL,
     url text NOT NULL UNIQUE,
     title text,
     caption text,
     language text,
     duration_sec real,
     thumbnail text,
     transcript text NOT NULL DEFAULT '',
     english text NOT NULL DEFAULT '',
     status text NOT NULL DEFAULT 'pending',
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS chunks(
     id serial PRIMARY KEY,
     source_id int NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
     idx int NOT NULL,
     start_sec real,
     end_sec real,
     original text NOT NULL,
     english text,
     status text NOT NULL DEFAULT 'pending',
     error text,
     UNIQUE(source_id, idx))`,
  `CREATE TABLE IF NOT EXISTS rules(
     id serial PRIMARY KEY,
     trader_id int NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
     source_id int NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
     chunk_id int REFERENCES chunks(id) ON DELETE CASCADE,
     ord int NOT NULL DEFAULT 0,
     category text,
     concept text,
     title text,
     rule text,
     explanation text,
     conditions jsonb NOT NULL DEFAULT '[]',
     entry text,
     stop_loss text,
     target text,
     invalidation text,
     timeframe text,
     instruments text,
     indicators jsonb NOT NULL DEFAULT '[]',
     ambiguities jsonb NOT NULL DEFAULT '[]',
     related jsonb NOT NULL DEFAULT '[]',
     quote text,
     timestamp_sec real,
     quote_found boolean NOT NULL DEFAULT false,
     verified boolean NOT NULL DEFAULT false,
     review_note text,
     created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS rules_trader_idx ON rules(trader_id)`,
  `CREATE INDEX IF NOT EXISTS sources_trader_idx ON sources(trader_id)`,
];

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

export function neonUrlFrom(req) {
  const v = req.headers["x-neon-url"];
  const url = (Array.isArray(v) ? v[0] : v || "").trim();
  if (!url) throw new HttpError(400, "Add your Neon database URL in API keys.", { code: "keys" });
  let u;
  try { u = new URL(url); } catch { throw new HttpError(400, "Your Neon database URL isn't valid. Copy it again from Neon → Connect.", { code: "keys" }); }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !/\.neon\.(tech|build)$/i.test(u.hostname)) {
    throw new HttpError(400, "The Neon URL should look like postgresql://user:password@ep-....neon.tech/neondb?sslmode=require", { code: "keys" });
  }
  return url;
}

// Returns q(text, params) -> rows. Creates the tables on first use.
export async function db(req) {
  const url = neonUrlFrom(req);
  const sql = neon(url);
  const q = async (text, params = []) => {
    try { return await sql.query(text, params); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (/password authentication|authentication failed|role .* does not exist/i.test(msg)) throw new HttpError(400, "Neon rejected the database URL (wrong password or user). Copy it again from Neon → Connect.", { code: "keys" });
      if (/fetch failed|ENOTFOUND|getaddrinfo|endpoint .* not found|could not find/i.test(msg)) throw new HttpError(400, "Couldn't reach your Neon database. Check the URL in API keys, and that the project still exists.", { code: "keys" });
      if (/exceeded|quota|size limit/i.test(msg)) throw new HttpError(507, "Your Neon database is full or over its free quota. Check your Neon dashboard.");
      throw new HttpError(500, "Database error: " + msg.slice(0, 200));
    }
  };
  if (!ready.has(url)) {
    for (const s of SCHEMA) await q(s);
    ready.add(url);
  }
  return q;
}

export function header(req, name) {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v || "").trim();
}

export function readBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  return body && typeof body === "object" ? body : {};
}

export function send(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  const out = { ok: false, error: err instanceof HttpError ? err.message : "Something went wrong on the server." };
  if (err && err.code) out.code = err.code;
  if (err && err.retryAfter != null) out.retryAfter = err.retryAfter;
  if (!(err instanceof HttpError)) console.error("kb error", err && err.message);
  return res.status(status).json(out);
}
