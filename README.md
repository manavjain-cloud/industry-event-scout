# Industry Event Scout

An AI-powered **weekly event intelligence digest** for an independent management consultant (Vikram, from the
Mesa C4 problem statement). Every Monday morning it searches the live web for conferences, roundtables, CXO summits and
startup meetups in his professional domains and target cities for the **next 30 days**, removes duplicates, ranks the events
against his focus areas with **Gemini Flash**, flags registration deadlines **fewer than 7 days away**, and emails a digest he can scan in under five minutes.

> The email is the product. The dashboard supports it: review events, edit focus areas and cities without touching code,
> preview / test-send the digest, trigger a controlled refresh and check whether scheduled runs succeeded.

- **Live app:** https://industry-event-scout.vercel.app (dashboard is password-protected) · **Repository:** https://github.com/manavjain-cloud/industry-event-scout
- Verified on the deployed app (2026-10-12): protected endpoints answer 401 anonymously; a real weekly run completed in about 140 s (14 Tavily searches, 10 Gemini calls) and its email was accepted by Resend; a second identical cron call was refused as `already_sent`; Vercel lists the cron `/api/cron/weekly-digest` on `30 2 * * 1`.
- Problem statement: [`Problem Statement 15.pdf`](<Problem Statement 15.pdf>) · Components Map: [`industry_event_scout_components_map.jpg`](industry_event_scout_components_map.jpg) (both kept intact)
- Architecture (as built): [`docs/components-map.md`](docs/components-map.md) · Nine Checks: [`docs/nine-checks.md`](docs/nine-checks.md)

## Architecture in one picture

`TRIGGER → INPUT → CONTEXT → PROCESSING → AI → OUTPUT`

| Step | Implementation |
| --- | --- |
| **Trigger** | Vercel Cron `30 2 * * 1` (Monday 02:30 UTC = 08:00 IST) → protected `GET /api/cron/weekly-digest` (`Bearer CRON_SECRET`); protected manual refresh and test-email actions |
| **Input** | Tavily live search (bounded, preference-driven queries) + public event pages and schema.org markup (robots.txt-aware, SSRF-safe) |
| **Context** | Neon PostgreSQL: preferences, events, sources, run history; the 30-day window, 7-day rule and ranking criteria are passed explicitly |
| **Processing** | Plain TypeScript: normalize, evidence-check, de-duplicate, filter, compute deadline urgency |
| **AI** | Gemini Flash only: structured extraction (with quoted evidence) and 0-100 relevance + summary + rationale, validated with Zod |
| **Output** | Resend email (HTML + text), Neon records, Next.js dashboard with run history |

Rules the code enforces and tests cover: 30-day window · deadline *strictly* under 7 days is urgent (exactly 7 is not; unknown stays unknown) ·
every event keeps its original links · nothing is fabricated · failures are recorded · a retried run can never send a second digest.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript (strict) · React 19 · Tailwind CSS 4 · Lucide · Zod · `@google/genai` · Tavily REST API ·
`@neondatabase/serverless` · Resend · Vercel (hosting + Cron) · `three` / `threejs-components` for the interactive neon-tube hero · Vitest + Testing Library + PGlite · Playwright.

## Environment variables

Copy [`.env.example`](.env.example) to `.env.local` (git-ignored) for local work; set the same names in **Vercel → Project → Settings → Environment Variables**.
Server-only secrets are never prefixed `NEXT_PUBLIC_` and never reach the browser.

| Variable | Where to get it | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon console → *Connection details* (pooled, `sslmode=require`) | |
| `TAVILY_API_KEY` | app.tavily.com → API Keys (`tvly-…`) | free plan: 1,000 credits/month |
| `GEMINI_API_KEY` | Google AI Studio → *Get API key* | |
| `GEMINI_MODEL` | any Gemini **Flash** model your key can use | default `gemini-3.8-flash` (works with a standard AI Studio key; `gemini-2.5-flash` is closed to new users); confirm with `npm run check:integrations -- gemini` (it lists what your key can use) |
| `RESEND_API_KEY` | resend.com → API Keys | |
| `RESEND_FROM_EMAIL` | e.g. `Industry Event Scout <onboarding@resend.dev>` | see *Email delivery* below |
| `CRON_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | ≥ 16 chars; Vercel sends it automatically as `Authorization: Bearer …` |
| `ADMIN_PASSWORD` | choose one | ≥ 12 chars; dashboard sign-in. **Optional switch:** leave it unset/empty and the dashboard opens with **no login** (demo mode). Anyone with the URL can then change settings, trigger refreshes and send test emails, limited only by the run throttles and same-origin check; the cron endpoint still needs `CRON_SECRET`. A password that is set but invalid keeps the dashboard locked. |
| `AUTH_SECRET` | generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` | ≥ 32 chars; signs the session cookie |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` locally, your Vercel URL when deployed | public, used for the dashboard link in emails |

The recipient email, cities, focus areas and timezone are **not** environment variables: they live in Neon and are edited in the dashboard.

## Local setup

```bash
npm install
cp .env.example .env.local        # then fill in the values (Windows: copy .env.example .env.local)
npm run db:setup                  # creates the tables in Neon (idempotent)
npm run check:integrations        # live PASS/FAIL per service; never prints secrets, never sends email
npm run dev                       # http://localhost:3000  → Sign in → Dashboard
```

The dashboard works with whatever is configured: a missing key only disables the stage that needs it, and the *Setup incomplete* panel names the variables (never values).

## Tests

```bash
npm test                 # 200+ unit/component tests, mocked services, real in-process Postgres (PGlite)
npm run typecheck        # next typegen + tsc --noEmit
npm run lint
npm run build            # production build
npm run test:e2e         # Playwright smoke test in an installed browser (default Edge; PW_CHANNEL=chrome to change)
npm run test:live        # LIVE path: real Tavily + Gemini + Neon, stub mailer (never emails)
```

What the unit tests cover: 30-day filtering; deadlines at 6 / 7 / 8 days, missing and expired deadlines, midnight, timezone and DST handling;
de-duplication across different URLs; malformed Gemini JSON and scores outside 0-100; missing / malicious URLs; empty search results;
Tavily, Gemini, Neon and Resend failures; cron authentication; unauthorised dashboard access; duplicate-run / duplicate-send protection.
External services are mocked in `npm test`; nothing in it needs credentials. Live behaviour is checked separately by `npm run test:live` and `check:integrations`.

## Testing live discovery

1. Fill `DATABASE_URL`, `TAVILY_API_KEY`, `GEMINI_API_KEY`; run `npm run db:setup`.
2. Sign in, open **Settings**, confirm your focus areas and cities, save.
3. Click **Refresh events**. It searches live, retrieves pages, extracts and ranks. Progress appears in the banner; **Runs & metrics** shows each stage, its timing, its counts and any error.
   (Refresh never sends the weekly email. It is limited to one run per 5 minutes to protect your API quotas.)
4. Open **Events**. Every card links to its original source(s); fields a source did not publish show as "not confirmed" / "not published".

## Previewing and testing the email

- **Digest preview** tab → *Preview next digest* renders the exact HTML + text from stored events. Nothing is sent and no API is called.
- *Send test email* sends one clearly labelled message (`[TEST]` subject and banner) to the configured recipient. It is rate-limited (one per 2 minutes), recorded as its own run, and can never be mistaken for or block the weekly digest.
- The application never sends emails on its own except the scheduled weekly digest.

### Email delivery (Resend) - the one external setup step you must decide on

`onboarding@resend.dev` is Resend's **testing sender**: per [Resend's documentation](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain) it can only deliver to the email address of your own Resend account.
To email anyone else (for example Vikram), **verify a domain in Resend** (Resend dashboard → Domains → add DNS records), then set
`RESEND_FROM_EMAIL="Industry Event Scout <digest@your-verified-domain>"`. If Resend refuses a send, the run is recorded as `failed` with Resend's message and shown on the dashboard.
Free-plan limits (verified 2026-10-12): 3,000 emails/month and 100/day.

## How weekly scheduling works

`vercel.json` registers one cron job: `30 2 * * 1` (UTC; Vercel Cron is always UTC) = **Monday 08:00 India Standard Time**. At that time Vercel makes an
HTTP `GET` to `/api/cron/weekly-digest` with `Authorization: Bearer $CRON_SECRET`; anything else gets `401` before any work or spending.

- **Hobby plan caveats (from Vercel's docs):** cron may run **once per day at most**, and Vercel may invoke it *at any point within the scheduled hour* (so 07:30-08:29 IST), not at the exact minute. Pro plans run within the minute.
  Delivery is best-effort: Vercel does not retry failed invocations and may occasionally deliver the same schedule twice.
- **Idempotency:** each ISO week has one run row (`weekly:2026-W42`). A duplicate delivery while it runs is refused; once the email is `sent` it can never be sent again; a failed or crashed run can be retried and takes over the same row.
  To retry a failed week manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron/weekly-digest`.
- A weekly run is allowed up to 300 s (the Hobby maximum); the pipeline keeps its own 255 s budget and reports anything it had to skip.

## Deploying to Vercel (with GitHub)

1. Push the repository to GitHub (see below).
2. In Vercel: **Add New → Project → Import** the GitHub repo (framework: Next.js is auto-detected; no build settings to change).
3. Add all variables from the table above under **Environment Variables** (Production). Use your final Vercel URL for `NEXT_PUBLIC_APP_URL` (redeploy after you know it).
4. Run `npm run db:setup` once against the production `DATABASE_URL` (from your machine with that URL in `.env.local`).
5. Deploy. Then **Project → Settings → Cron Jobs** should list `/api/cron/weekly-digest` with `30 2 * * 1`.
6. Verify: sign in on the public URL, *Refresh events*, *Preview*, *Send test email*; optionally trigger the cron endpoint manually (command above) and check **Runs & metrics**.

Vercel Hobby is free; if you outgrow it (exact-minute cron, higher limits) that is a paid upgrade and nothing in the app silently requires one.

## GitHub submission

```bash
git init -b main                         # already done in this folder
git add -A && git commit -m "Industry Event Scout"
# create an empty repo on github.com (no README), then:
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Submit: the **public Vercel URL**, the **GitHub repository URL**, and the **Components Map** (`industry_event_scout_components_map.jpg`; the as-built version with diagrams is `docs/components-map.md`).
`.env.local` and any file matching `*keys*.txt` are git-ignored; verify with `git status` before pushing.

## Known limitations (honest scope)

- **Coverage is broad, not exhaustive.** No private newsletters; no logging in; LinkedIn, Facebook, Instagram and X pages are never fetched directly (only what a public search snippet states is used); paywalls, CAPTCHAs and robots.txt are respected.
  An event announced *only* on LinkedIn may therefore be missed - the product says this rather than hiding it.
- Dates, venues and deadlines are shown only when a source states them (schema.org markup, or a verbatim quote the code verified). A source can itself be wrong or out of date; always confirm on the original page.
- Event times are not modelled (dates are local calendar dates in the configured timezone; events in other timezones may be off by a day near midnight).
- "Online-only" events are excluded (the product is about in-person networking); events whose known city is not one of your target cities are excluded; unknown cities are kept.
- Gemini scores are decision support, not a probability of winning a client. Free-tier quotas can limit how many events get ranked in a run; unranked events are reported, never given invented scores.
- JS-only event sites may expose little text to a plain fetch; Tavily's extracted content is used as a fallback, otherwise the event may lack details.

## Free tiers and potential costs (verified 2026-10-12 - re-check before relying on them)

| Service | Free-plan fact | What could cost money |
| --- | --- | --- |
| Vercel Hobby | cron once/day within the hour; functions ≤ 300 s | exact-minute cron or longer jobs → Pro |
| Neon Free | 100 CU-hours/project/month, 1 GB storage, scale-to-zero after 5 min | more storage/compute |
| Tavily | 1,000 credits/month; basic search = 1 credit | the app uses ≤ 14 per run; more usage → paid plan |
| Resend | 3,000/month, 100/day; test sender only emails the account owner | domain verification is free but requires DNS access to a domain you own |
| Gemini | free-tier limits depend on model and are shown in AI Studio | high volumes → paid tier |

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Dashboard says **Setup incomplete** | Add the named variables to `.env.local` / Vercel and redeploy; run `npm run db:setup` for the database. |
| `npm run check:integrations` → gemini FAIL "model … not available" | It prints the Flash models your key can use; set `GEMINI_MODEL` to one of them. |
| Run is `partial`, stage `search (Tavily)` failed with 401/432 | Wrong key or plan limit reached. Credits reset monthly. |
| Run `failed`, email error mentions *verify a domain* / 403 | You are using `onboarding@resend.dev` to a non-owner address. Verify a domain in Resend and update `RESEND_FROM_EMAIL`. |
| Email says "AI ranking was unavailable" | Gemini quota/outage; events are listed by urgency and date with **no scores**. Re-run later. |
| "Please wait before starting another run" | Cost-control throttle (5 min) or a run is still in progress. |
| Cron did not run | Check *Settings → Cron Jobs* and the function logs; Hobby may fire anywhere in the scheduled hour. Trigger manually with the `curl` above (idempotent). |
| Login blocked for 10 minutes | 5 failed attempts from one address; wait, or clear `auth_attempts` in Neon. |
| `/api/cron/weekly-digest` returns 401 | `CRON_SECRET` missing/different in the Vercel project; redeploy after changing it. |
| Dashboard empty after a successful run | Nothing matched your cities/window, or sources hid their dates; check the run's stage details. |

## Repository map

```
src/lib/dates       deterministic window + deadline rules          src/lib/input       Tavily, query planning, page fetch, JSON-LD
src/lib/processing  normalize, evidence checks, dedupe, filters    src/lib/ai          Gemini client, prompts, schemas, extract, rank
src/lib/output      digest assembly, email HTML/text, Resend       src/lib/pipeline    stages + entry points (weekly, manual, test)
src/lib/db          Neon access (batched queries, claims)          src/lib/auth        session, cron secret, login throttle
src/app             pages + protected API routes                   src/components      dashboard UI, Tubes background
db/migrations       SQL schema                                      tests/              unit, component, e2e, live
```

## Security notes

Secrets only in server-side environment variables; `.env*` git-ignored (except `.env.example`); dashboard cookie is signed, HttpOnly and SameSite=Strict; mutating routes check Origin;
login failures are throttled in Neon (IP is stored only as a keyed hash); cron secret compared in constant time; logs redact key and connection-string patterns; retrieved web content is escaped in emails and the dashboard and treated as untrusted data in prompts.
