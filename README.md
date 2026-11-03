# Reel Script Desk

Paste Instagram reel links (comma separated, up to 30). For each reel you get the cover image and account (to confirm it's the right post), a title, the topic, editing notes, and the full script in English. Hindi, Kannada and other languages are translated; English is kept word for word. The original transcript is shown too.

## How it works

Every visitor brings their own keys. Open **API keys** in the left menu and add:

- **Groq API key** (required): Whisper large-v3 transcription + `openai/gpt-oss-120b` for the English script, topic and editing notes.
- **Apify API token**: finds the reel's video, cover and caption (Instagram Scraper).
- **Make.com webhook URL** (optional): if set, each reel is sent to that Make scenario instead, with `{ url, groqKey, apifyKey }` in the body. The scenario must reply with the same JSON shape (see `api/transcribe.js`).

Keys are saved only in the visitor's browser (localStorage), sent with that visitor's own requests, and never stored or logged by the server.

Browser → `/api/transcribe` (Vercel function) → Apify → video download → Groq Whisper → Groq LLM → JSON.

## Deploy on Vercel

1. vercel.com → Add New → Project → import this repo. No build settings and no environment variables needed.
2. Deploy.

## Limits

- 3 reels run at a time, about 30–60 s each.
- Only public reels and video posts work; videos over 25 MB are rejected by Groq.
- Editing notes are inferred from audio and caption, not from the video frames.
- Costs go to each user's own accounts: Apify (~$2–3 per 1,000 reels, $5 free monthly credit) and Groq (free tier, then very cheap).
