# Reel Script Desk

Paste Instagram reel links (comma separated, up to 30). For each reel you get the cover image and account (to confirm it's the right post), a title, the topic, editing notes, and the full script in English. Hindi, Kannada and other languages are translated; English is kept word for word. The original transcript is shown too.

## How it works

Browser → `/api/transcribe` (Vercel function) → Make webhook scenario "Instagram Reel -> Groq Whisper Transcript":
Apify Instagram Scraper → download video → Groq `whisper-large-v3` → Groq `openai/gpt-oss-120b` (translation, topic, editing notes) → JSON back.

API keys (Apify, Groq) stay inside Make. The Make webhook URL stays in a Vercel environment variable.

## Deploy on Vercel

1. vercel.com → Add New → Project → import this repo. No build settings needed.
2. Settings → Environment Variables:
   - `MAKE_WEBHOOK_URL` = your Make webhook URL (`https://hook.eu1.make.com/...`)
   - `APP_PASSWORD` = any password (recommended, so strangers can't use your credits). Enter it once with the "App password" button; the browser remembers it.
3. Deploy, then redeploy after changing env vars.

## Limits

- 3 reels run at a time, about 30–60 s each.
- Only public reels and video posts work.
- Editing notes are inferred from audio and caption, not from the video frames.
- Costs: Apify (~$2–3 per 1,000 reels, $5 free monthly credit), Groq (free tier, then very cheap), Make (~10 operations per reel).
