// Neon Object Storage (S3-compatible) for the team's own Neon project.
// `neon deploy` provisions the "assets" bucket (see neon.ts) and pulls
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3 and AWS_REGION.
// Used only together with the team database (DATABASE_URL), because the bucket
// branches with that database. Users who bring their own Neon URL keep the old
// behaviour: thumbnails stay inline in their database.
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const BUCKET = "assets";
const PREFIX = "s3:"; // marks a bucket key stored in a text column
const MAX_BYTES = 3 * 1024 * 1024;

// Vercel reserves the AWS_* names, so on Vercel set the same values as NEON_S3_*.
// Locally the AWS_* names from .env.local work as they are.
const cfg = () => {
  const e = process.env;
  return {
    accessKeyId: e.NEON_S3_ACCESS_KEY_ID || e.AWS_ACCESS_KEY_ID,
    secretAccessKey: e.NEON_S3_SECRET_ACCESS_KEY || e.AWS_SECRET_ACCESS_KEY,
    endpoint: e.NEON_S3_ENDPOINT || e.AWS_ENDPOINT_URL_S3,
    region: e.NEON_S3_REGION || e.AWS_REGION || "us-east-2",
  };
};
let client = null;
export function storageEnabled() {
  const c = cfg();
  return !!(c.accessKeyId && c.secretAccessKey && c.endpoint);
}
function s3() {
  if (!client) {
    const c = cfg();
    client = new S3Client({
      forcePathStyle: true, // required: Neon uses path-style addressing
      region: c.region, endpoint: c.endpoint,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
  }
  return client;
}

export async function putObject(key, body, contentType) {
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType, CacheControl: "private, max-age=31536000, immutable" }));
  return key;
}

export async function getObject(key) {
  const r = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { bytes: await r.Body.transformToByteArray(), contentType: r.ContentType };
}

export const presign = (key, expiresIn = 6 * 3600) =>
  getSignedUrl(s3(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn });

// Thumbnails arrive as data: URLs (Instagram, via Make) or remote URLs that may
// expire (Instagram CDN) or YouTube image URLs. Copy them into the bucket and
// return "s3:<key>". On any problem, return the original value unchanged.
export async function storeThumbnail(thumb) {
  thumb = String(thumb || "");
  if (!thumb || !storageEnabled()) return thumb;
  try {
    let bytes, type;
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(thumb);
    if (m) { type = m[1]; bytes = Buffer.from(m[2], "base64"); }
    else if (/^https:\/\//i.test(thumb)) {
      const r = await fetch(thumb, { signal: AbortSignal.timeout(8000) });
      type = (r.headers.get("content-type") || "").split(";")[0].trim();
      if (!r.ok || !/^image\//.test(type)) return thumb;
      bytes = Buffer.from(await r.arrayBuffer());
    } else return thumb;
    if (!bytes.length || bytes.length > MAX_BYTES) return thumb;
    const ext = (type.split("/")[1] || "img").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
    const key = `thumbnails/${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
    await putObject(key, bytes, type);
    return PREFIX + key;
  } catch (e) {
    console.error("thumbnail upload failed", e && e.message);
    return thumb;
  }
}

// Turn "s3:<key>" back into a short-lived signed URL the browser can load.
export async function resolveThumbnail(value) {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return value;
  if (!storageEnabled()) return "";
  try { return await presign(value.slice(PREFIX.length)); } catch { return ""; }
}
