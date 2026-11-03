# Reel Script Desk

Paste Instagram reel links (comma separated, up to 30). For each reel you get the cover image and account (to confirm it's the right post), a title, the topic, editing notes, and the full script in English. Hindi, Kannada and other languages are translated; English is kept word for word. The original transcript is shown too.

## How it works

Every visitor brings their own keys. Open **API keys** in the left menu and add:

- **Groq API keys** (1 required, up to 3 from teammates; reels are spread across them and a failed reel is retried with the next key; passed to the user's scenario): Whisper large-v3 transcription + `openai/gpt-oss-120b` for the English script, topic and editing notes.
- **Apify API tokens** (1 required, up to 3; same rotation; passed to the user's scenario): finds the reel's video, cover and caption (Instagram Scraper).
- **Make.com webhook URL** (required): each user imports `make-blueprint.json` into their own Make account, so all runs are billed to them. Steps are shown in the app under the field.

Keys are saved only in the visitor's browser (localStorage), sent with that visitor's own requests, and never stored or logged by the server.

Browser → `/api/transcribe` (Vercel function, only forwards) → the user's own Make webhook scenario (Apify → video download → Groq Whisper → Groq LLM) → JSON.

## Deploy on Vercel

1. vercel.com → Add New → Project → import this repo. No build settings and no environment variables needed.
2. Deploy.

## Limits

- 3 reels run at a time, about 30–60 s each.
- Only public reels and video posts work; videos over 25 MB are rejected by Groq.
- Editing notes are inferred from audio and caption, not from the video frames.
- Costs go to each user's own accounts: Apify (~$2–3 per 1,000 reels, $5 free monthly credit) and Groq (free tier, then very cheap).
