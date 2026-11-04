# Reel Script Desk

Paste Instagram reel links (comma separated, up to 50). For each reel you get the cover image and account (to confirm it's the right post), a title, the topic, editing notes, and the full script in English. Hindi, Kannada and other languages are translated; English is kept word for word. The original transcript is shown too.

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

## Neon team project (database + file storage)

`neon.ts` declares the team's Neon services: Postgres and a private `assets` bucket.
`neon deploy` provisions them and writes their env vars to `.env.local` (never committed).

- **Database.** If `DATABASE_URL` is set, the knowledge base uses it whenever a user hasn't
  pasted their own Neon URL in API keys. A pasted URL still wins, for a private knowledge base.
- **File storage.** Thumbnails for sources saved to the team database are copied into the
  `assets` bucket (Instagram's image links expire) and shown through short-lived signed URLs.

Vercel env vars (Settings → Environment Variables). Vercel reserves the `AWS_*` names,
so the storage values use `NEON_S3_*` names there:

| Vercel name | Value from `.env.local` |
| --- | --- |
| `DATABASE_URL` | `DATABASE_URL` (pooled) |
| `NEON_S3_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` |
| `NEON_S3_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` |
| `NEON_S3_ENDPOINT` | `AWS_ENDPOINT_URL_S3` |
| `NEON_S3_REGION` | `AWS_REGION` |

Without these, the app behaves as before: each user pastes their own Neon URL.

## Limits

- 3 reels run at a time, about 30–60 s each.
- Only public reels and video posts work; videos over 25 MB are rejected by Groq.
- Editing notes are inferred from audio and caption, not from the video frames.
- Costs go to each user's own accounts: Apify (~$2–3 per 1,000 reels, $5 free monthly credit) and Groq (free tier, then very cheap).

## Team usage dashboard

- **Apify:** live monthly balance per token from Apify's API (`/api/usage`), shown as "≈ reels left" using an estimated $2.70 per 1,000 reels. It counts down after every reel and re-syncs with Apify after each batch.
- **Groq:** the free tier resets daily. After each reel, the Make scenario returns Groq's own `x-ratelimit-remaining-requests` headers, so each key shows real "reels left today". Tokens and audio seconds per reel are added up per key.
- Totals (blue pills) add up all keys. Pills turn orange under 20 reels left and red when empty.

## Trader knowledge base

Open **Knowledge base** in the left menu. Paste Instagram reels and YouTube videos together (comma separated, up to 50; `watch`, `youtu.be`, `shorts` and `live` links all work).

For each link:

1. **Transcript.** Instagram reels go through the user's Make webhook (same as Transcribe). YouTube videos use Apify's YouTube Scraper (`streamers/youtube-scraper`) in captions-only mode, so the video needs captions on YouTube (auto captions are fine).
2. **Trader detection.** The Instagram handle or YouTube channel is looked up. A known account goes to its trader page; a new channel whose name matches an existing trader goes there; otherwise a new trader page is created. The "File under" menu forces a trader, and **Merge** joins two pages (for example an Instagram handle and a YouTube channel of the same person). After a merge, both accounts file under that page.
3. **Full transcript, word for word.** The original-language transcript and the English version are both saved. YouTube transcripts keep `[mm:ss]` timestamps.
4. **Rule extraction** with `openai/gpt-oss-120b`, in 3-minute parts:
   - translate (when not English, line by line, never summarized),
   - extract every rule with the trader's exact quote, explanation, conditions, entry, stop loss, target, invalidation, timeframe, instruments, indicators and settings. Anything the trader didn't say is written as "Not stated", and gaps go into "Not specified by the trader",
   - verify: a second pass audits every field against the transcript and lists missed rules; the quote is also checked word for word in code. Rules that pass everything are **Verified against transcript**; anything else is marked **Needs review** with the reason.

Each trader page has **Copy knowledge base** and **Download .md** at the top (a Markdown file for AI: rules grouped by concept, quotes, sources with timestamps, and every full transcript), plus tabs for Rules (search, filter by concept, "only rules to review"), Knowledge graph (concepts and how they connect), Sources & transcripts (re-extract or delete a source), and Manage (rename, merge, delete).

Everything is stored in the user's own **Neon** Postgres database. Paste its connection string in **API keys** (steps are shown under the field). Tables are created automatically. Anyone with the URL can read and write the data, so share it only with teammates who should build the same knowledge base.

Browser → `/api/youtube` (Apify) or `/api/transcribe` (Make) → `/api/kb` (Neon + Groq, one step per call) → the user's Neon database.

### Limits

- Groq's free tier allows about 8,000 tokens a minute for `gpt-oss-120b`, so parts run one step at a time and the page waits and rotates keys when it hits the limit. A 1-hour video takes about 15–25 minutes.
- YouTube videos without captions aren't supported yet.
- Neon's free plan includes limited storage per project (see neon.com/pricing). Transcripts are text, so thousands of videos fit.
- No automatic process can promise zero mistakes. Every rule carries its exact quote and source so it can be checked, and anything that fails a check is marked Needs review.
