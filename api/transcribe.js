// Vercel serverless function. Each user brings their own keys:
//   x-groq-key      (required)  Groq API key
//   x-apify-key     (required in direct mode)  Apify API token
//   x-make-webhook  (optional)  the user's own Make webhook URL
// With a Make webhook, the request (including both keys) is forwarded to it.
// Without one, this function calls Apify and Groq directly.
// Keys are only used for this one request. They are never stored or logged.


const LLM_MODEL = "openai/gpt-oss-120b";
const STT_MODEL = "whisper-large-v3";

const SYSTEM_PROMPT =
  "You analyze one Instagram reel. You get the detected spoken language, the caption, the duration and the exact speech transcript. " +
  "Return ONLY a JSON object with these keys: " +
  '"title": a short name for the reel (max 8 words, English); ' +
  '"topic": what the reel is about, 1-2 sentences in English; ' +
  '"editing": an array of 3-6 short strings describing the hook, structure, pacing and style (voiceover vs talking head, CTA, on-screen text hints) inferred from the transcript, caption and duration; ' +
  '"language": the spoken language name in English (for example English, Hindi, Kannada, Hinglish); ' +
  '"english_script": the COMPLETE script in accurate, natural English. If the transcript is already English, copy it exactly, word for word. ' +
  "If it is Hindi, Kannada or any other language (or mixed), translate EVERY sentence faithfully into English. Never summarize, shorten, skip or add content. Keep the original order. " +
  'If the transcript is empty or only music, set english_script to "(no speech detected)".';

class UserError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function header(req, name) {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v || "").trim();
}

async function readJson(r, who) {
  const text = await r.text();
  if (r.status === 401 || r.status === 403) throw new UserError(400, `${who} rejected the API key. Check it in API keys.`);
  if (r.status === 429) throw new UserError(429, `${who} rate limit reached. Wait a minute and try again.`);
  if (!r.ok) {
    let msg = text.slice(0, 200);
    try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error)) || msg; } catch {}
    throw new UserError(502, `${who} error: ${msg}`);
  }
  try { return JSON.parse(text); } catch { throw new UserError(502, `${who} returned an unreadable response.`); }
}

async function viaMake(webhook, url, groqKey, apifyKey) {
  const r = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, groqKey, apifyKey }),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch {
    throw new UserError(502, "Your Make webhook didn't return a result. Check the scenario is ON and ends with a Webhook response module.");
  }
}

async function direct(url, groqKey, apifyKey) {
  // 1. Apify: find the reel's video, cover and caption
  const ap = await fetch(
    "https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=" + encodeURIComponent(apifyKey),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directUrls: [url], resultsType: "posts", resultsLimit: 1, addParentData: false }),
    }
  );
  const items = await readJson(ap, "Apify");
  const post = Array.isArray(items) ? items[0] : null;
  if (!post || !post.videoUrl) throw new UserError(404, "No video found. The reel may be private, deleted, or a photo post.");

  // 2. Download video and cover
  const [vid, img] = await Promise.all([fetch(post.videoUrl), post.displayUrl ? fetch(post.displayUrl) : null]);
  if (!vid.ok) throw new UserError(502, "Couldn't download the reel video from Instagram.");
  const videoBuf = await vid.arrayBuffer();
  if (videoBuf.byteLength > 25 * 1024 * 1024) throw new UserError(413, "This reel is larger than Groq's 25 MB limit.");
  let thumbnail = "";
  if (img && img.ok) {
    const b = Buffer.from(await img.arrayBuffer());
    thumbnail = `data:${img.headers.get("content-type") || "image/jpeg"};base64,${b.toString("base64")}`;
  }

  // 3. Groq Whisper large-v3: exact transcript in the spoken language
  const form = new FormData();
  form.append("file", new Blob([videoBuf], { type: "video/mp4" }), "reel.mp4");
  form.append("model", STT_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");
  const stt = await readJson(
    await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}` },
      body: form,
    }),
    "Groq"
  );

  // 4. Groq LLM: English script, topic, editing notes
  const userMsg =
    `DETECTED LANGUAGE: ${stt.language || ""}\nDURATION SECONDS: ${stt.duration || ""}\n` +
    `CAPTION: ${post.caption || ""}\nTRANSCRIPT:\n${stt.text || ""}`;
  const chat = await readJson(
    await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        reasoning_effort: "low",
        temperature: 0.1,
        max_completion_tokens: 12000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
      }),
    }),
    "Groq"
  );
  let ai = {};
  try { ai = JSON.parse(chat.choices[0].message.content); } catch {}

  return {
    ok: true,
    owner: post.ownerUsername || "",
    postUrl: post.url || url,
    duration: String(stt.duration || ""),
    detectedLanguage: stt.language || "",
    caption: post.caption || "",
    transcript: stt.text || "",
    thumbnail,
    ai,
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST." });
  }
  try {
    const groqKey = header(req, "x-groq-key");
    const apifyKey = header(req, "x-apify-key");
    const webhook = header(req, "x-make-webhook");

    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    const url = String((body && body.url) || "").trim();
    if (!/^https:\/\/www\.instagram\.com\/(reel|p|tv)\/[A-Za-z0-9_-]+\/?$/.test(url)) {
      throw new UserError(400, "That doesn't look like an Instagram reel link.");
    }
    if (!groqKey) throw new UserError(400, "Add your Groq API key in API keys.");

    let data;
    if (webhook) {
      if (!/^https:\/\/hook\.[a-z0-9]+\.make\.com\/[A-Za-z0-9]+$/.test(webhook)) {
        throw new UserError(400, "The Make webhook URL should look like https://hook.eu1.make.com/abc123.");
      }
      data = await viaMake(webhook, url, groqKey, apifyKey);
    } else {
      if (!apifyKey) throw new UserError(400, "Add your Apify API token in API keys.");
      data = await direct(url, groqKey, apifyKey);
    }
    return res.status(200).json(data);
  } catch (e) {
    const status = e instanceof UserError ? e.status : 500;
    const error = e instanceof UserError ? e.message : "Something went wrong on the server. Try again.";
    return res.status(status).json({ ok: false, error });
  }
}
