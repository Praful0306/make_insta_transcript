// Optional file storage on the USER'S OWN Neon project (S3-compatible Object Storage).
// The server has no storage of its own. The page sends the user's bucket details as headers
// on each request; they are used for that request only and never stored or logged:
//   x-neon-s3-key, x-neon-s3-secret, x-neon-s3-endpoint, x-neon-s3-region, x-neon-s3-bucket
// Without them nothing changes: thumbnails stay inline in the user's database.
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { header, HttpError } from "./_db.js";

const PREFIX = "s3:"; // marks a bucket key stored in a text column
const MAX_BYTES = 3 * 1024 * 1024;
// Thumbnails fetched by URL must come from the platforms' own image hosts.
const IMAGE_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net|ytimg\.com|ggpht\.com)$/i;

// Returns null when the user hasn't set up storage, or { client, bucket } when they have.
const clients = new Map(); // per-credential clients, reused while the instance is warm
export function storageFrom(req) {
  const key = header(req, "x-neon-s3-key"), secret = header(req, "x-neon-s3-secret");
  const endpoint = header(req, "x-neon-s3-endpoint"), region = header(req, "x-neon-s3-region");
  const bucket = header(req, "x-neon-s3-bucket") || "assets";
  if (!key && !secret && !endpoint && !region) return null;
  const bad = m => new HttpError(400, m, { code: "keys" });
  if (!key || !secret || !endpoint || !region) throw bad("Neon file storage needs the access key, secret key, endpoint and region. Fill in all four in API keys, or clear them.");
  let u;
  try { u = new URL(endpoint); } catch { throw bad("The Neon storage endpoint isn't a valid URL. Copy it again from your Neon project."); }
  if (u.protocol !== "https:" || !/\.neon\.(tech|build)$/i.test(u.hostname)) throw bad("The Neon storage endpoint should look like https://br-....storage.....neon.tech");
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/i.test(bucket)) throw bad("The Neon bucket name isn't valid.");
  const id = createHash("sha256").update([key, secret, u.origin, region].join("\n")).digest("hex");
  let client = clients.get(id);
  if (!client) {
    if (clients.size > 20) clients.clear();
    client = new S3Client({
      forcePathStyle: true, // required: Neon uses path-style addressing
      region, endpoint: u.origin,
      credentials: { accessKeyId: key, secretAccessKey: secret },
    });
    clients.set(id, client);
  }
  return { client, bucket };
}

// Thumbnails arrive as data: URLs (Instagram, via Make) or image URLs that may expire.
// Copy them into the user's bucket and return "s3:<key>". On any problem, return the
// original value unchanged, so saving a video never fails because of storage.
export async function storeThumbnail(store, thumb) {
  thumb = String(thumb || "");
  if (!thumb || !store) return thumb;
  try {
    let bytes, type;
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(thumb);
    if (m) { type = m[1]; bytes = Buffer.from(m[2], "base64"); }
    else {
      let u; try { u = new URL(thumb); } catch { return thumb; }
      if (u.protocol !== "https:" || !IMAGE_HOSTS.test(u.hostname)) return thumb;
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      type = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!r.ok || !/^image\//.test(type)) return thumb;
      bytes = Buffer.from(await r.arrayBuffer());
    }
    if (!bytes.length || bytes.length > MAX_BYTES) return thumb;
    const ext = (type.split("/")[1] || "img").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
    const key = `thumbnails/${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
    await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: key, Body: bytes, ContentType: type, CacheControl: "private, max-age=31536000, immutable" }));
    return PREFIX + key;
  } catch (e) {
    console.error("thumbnail upload failed", e && e.name);
    return thumb;
  }
}

// Turn "s3:<key>" back into a short-lived signed URL the browser can load.
// Without the user's storage details the image can't be shown, so return "".
export async function resolveThumbnail(store, value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  if (!store) return "";
  try { return await getSignedUrl(store.client, new GetObjectCommand({ Bucket: store.bucket, Key: value.slice(PREFIX.length) }), { expiresIn: 6 * 3600 }); }
  catch { return ""; }
}
