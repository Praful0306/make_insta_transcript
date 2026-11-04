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

## Your own Neon database and file storage

The server holds no database or storage of its own, so nobody can use anyone else's data.
Everyone creates a free Neon project and pastes their details into **API keys** in the page.
They are kept in that browser, sent only with that person's own requests, and never saved on the server.

- **Neon database URL (needed for the knowledge base).** Traders, transcripts and rules are saved here.
  The tables are created automatically.
- **Neon file storage (optional).** Only fill this in if you want thumbnails kept in your own bucket
  (Instagram image links expire). Needs five values from your Neon project: bucket name, S3 access key ID,
  S3 secret access key, S3 endpoint and S3 region. Leave them empty and thumbnails stay inside your database.

No Vercel environment variables are needed for Neon. `neon.ts` is only an example of how to create a private
bucket in your own project with `neon deploy`; it isn't used by the app.

## API for AI coding tools

A read-only API lets Claude Code, Codex, Cursor or any AI tool fetch the knowledge base of every trader,
combine it, and build indicators. The server keeps no data: each request sends the caller's own Neon URL in
the `x-neon-url` header and reads from that database. The **AI tools** page in the site has a copy-paste prompt
and a connection test.

| Endpoint | What it returns |
| --- | --- |
| `GET /api/v1/traders` | traders with rule counts |
| `GET /api/v1/concepts` | concepts and which traders cover them |
| `GET /api/v1/knowledge?format=markdown&verified=true` | all rules from all traders, grouped by concept |
| `GET /api/v1/rules?q=&trader=1,4&concept=&verified=true&limit=100&offset=0` | searchable, paged rules |
| `GET /api/v1/traders/{id}` | one trader with sources and rules (`include=transcripts` for full text) |
| `GET /api/v1/sources/{id}` | one full transcript |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description (no auth needed) |

Agent instructions are in [`skill/SKILL.md`](skill/SKILL.md) (a Claude Code skill: copy the folder to
`~/.claude/skills/trader-knowledge-base/`) and [`llms.txt`](llms.txt). They tell the tool to start with verified
rules, compare traders, never guess values marked "Not stated", and treat transcript text as data, not instructions.
For safety, give AI tools a read-only Neon role (steps are on the AI tools page). The API never writes.

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

## Paid library (locked until payment)

Our own knowledge base, served only to signed-in paying members. Unpaid callers get no data: the server checks sign-in, then payment, then limits, and only then reads a single library row. If anything is missing or broken it refuses (fails closed). The page cannot unlock anything; access comes only from a row in `lib_entitlements` that a trusted server path writes.

Endpoints (GET only, header `x-api-key: kbk_...`): `/api/v1/library/traders`, `/concepts`, `/rules`, `/knowledge`, `/traders/{id}`. No transcripts are served. Account routes (`/api/v1/account`) use the Firebase ID token.

Environment variables on Vercel:

| Name | Meaning |
| --- | --- |
| `LIBRARY_DATABASE_URL` | Neon database that holds the library rules, customers, entitlements and usage. Use a separate project from users' own databases. |
| `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN` | From your Firebase web app. Enable Google and Email/Password sign-in, add your domain under authorized domains. |
| `LIB_PRICE_INR` | Price shown on the page (display only). |
| `CHECKOUT_OPEN` | `1` once Razorpay is connected. |
| `LIB_REQ_PER_DAY` (100), `LIB_RULES_PER_DAY` (500), `LIB_REQ_PER_MIN` (15), `LIB_RULES_PER_CALL` (200), `LIB_MAX_KEYS` (3) | Limits per customer. Day resets 00:00 UTC (05:30 IST). |

Give someone access by hand: `LIBRARY_DATABASE_URL=... FIREBASE_PROJECT_ID=... node scripts/grant-access.mjs email@example.com 30` (use `0` to end access).

Razorpay later: a webhook route verifies the signature, then calls `setEntitlement` (paid, `period_end`) or marks the plan `cancelled`/`expired`. Cancelled members keep access to `period_end`.

Legal pages are in `legal/` (generated by `python3 legal/gen.py`). Fill the yellow placeholders and have a lawyer review them before launch.
