# Nine Checks: Industry Event Scout

The Nine Checks were used as **architectural and product guardrails**. They are not a score and they
are not related to the AI relevance score (0-100) that Gemini gives each event. Each section records
the evidence from the problem statement, what it implies for the build, the risks, and the scope cut
that follows. File references point at the code that enforces the decision.

Source of truth for the business problem: `Problem Statement 15.pdf` (Mesa C4, Section 1 final examination).

---

## Check 1 - Problem real? **YES**

**Evidence (from the problem statement)**

- Vikram's practice gets **40%** of new business from in-person events; face-to-face conversion is **3x** cold outreach.
- Relevant events are announced across Eventbrite, iSPIRT, conference sites and "a dozen industry newsletters" - there is no single source.
- He spends **45 minutes every Monday** searching manually and still misses things.
- He found a Bengaluru CIO roundtable **the day after the registration deadline**; the organiser had only posted on LinkedIn.

**Implication.** Prioritise (a) multi-source discovery, (b) registration deadlines, (c) removing the repetitive Monday search.

**Where it shows up.** Query planner covering Eventbrite/Luma/Meetup/10times/allevents and iSPIRT plus open-web focus x city queries
(`src/lib/input/queries.ts`); deadline extraction and the <7-day flag (`src/lib/dates/deadlines.ts`, `src/lib/processing/candidates.ts`);
a scheduled Monday email (`vercel.json`, `src/app/api/cron/weekly-digest/route.ts`).

**Risk.** The root cause in the story is an announcement that appeared *only on LinkedIn*. See Check 3: that exact failure mode is
partly out of reach, and the product says so rather than pretending otherwise.

---

## Check 2 - Workflow repeated? **YES**

**Evidence.** The same cycle happens every week: search, collect, filter, compare, rank, record deadlines, decide what to attend. His focus shifts "across the year".

**Implication.** Automate the whole weekly cycle, not a one-off search tool; make focus areas and cities editable without code.

**Where it shows up.** Weekly cron + idempotent weekly run key (`src/lib/pipeline/entrypoints.ts`); preferences stored in Neon and edited in the
protected dashboard (`src/lib/db/preferences.ts`, `src/components/dashboard/SettingsPanel.tsx`); search queries are rebuilt from saved
preferences on every run; scores carry a hash of the preferences they were computed for, so changed settings trigger re-ranking.

**Risk.** A shifting practice makes old scores stale. The dashboard marks scores that predate the latest settings, and the digest says so.

---

## Check 3 - Input available? **YES, WITH LIMITS**

**Available inputs.** Tavily search results (title, snippet, URL, extracted page content); publicly accessible event pages
(including schema.org `Event` markup, the most reliable source); user-defined domains and cities; previously collected records.

**Implication.** Combine live search with permitted public-page retrieval; keep source links; track missing fields.

**Where it shows up.**

- Retrieval policy in `src/lib/input/pageFetch.ts`: only http(s); **login-walled platforms (LinkedIn, Facebook, Instagram, X, YouTube) are never fetched directly**;
  `robots.txt` is honoured (and a failing `robots.txt` means *not fetched*); private/internal addresses are refused including on every redirect hop (SSRF);
  8 s timeout, 1.5 MB cap, HTML only; an identifying `User-Agent`.
- Missing facts are `NULL` in the database and "not published / unavailable" in the UI and email (`missing_fields`, `src/lib/processing/dedupe.ts`).

**Scope cut (explicit).** The system does **not** promise universal coverage. It does not read private newsletters, does not log in anywhere,
does not bypass paywalls/CAPTCHAs/platform restrictions, and does not use a paid scraping service. A LinkedIn-only announcement is visible only
if Tavily's public search surfaces its snippet; Gemini then extracts only what that snippet states.

**Risk.** Coverage is broad, not exhaustive. Each digest footer and the landing page state this.

---

## Check 4 - Output valuable? **YES**

**Principal output.** The weekly, ranked **email digest** with actionable detail and deadline alerts. The dashboard supports it; it does not replace it.

**Implication.** Email quality and delivery matter more than dashboard polish.

**Where it shows up.** `src/lib/output/email.ts` (responsive HTML + plain-text alternative, a conspicuous "Act now" block for deadlines <7 days, a warning
badge using icon + words + colour, unknown values printed as "unavailable"), `src/lib/output/digest.ts` (cap of `max_digest_events`, default 12; marginal matches
below 40/100 left out; reading time estimated from word count), `src/lib/output/mailer.ts` (Resend). Delivery status is stored per run and shown in the dashboard.
An empty week produces an honest "no matching events were found" email.

**Risk.** A great dashboard with failing email would not meet the brief. Email failure marks the run **failed** and is shown on the dashboard (see Check 6).

---

## Check 5 - Impact measurable? **YES**

**What is tracked** (all from real run records; `src/lib/dashboard-data.ts`, shown in *Runs & metrics*):

| Metric | How it is measured |
| --- | --- |
| Unique events discovered | events stored for the window (after de-duplication) |
| Relevant events returned | `retained` per run = events in the digest |
| Duplicate rate | `duplicatesRemoved` per run |
| Date provenance / accuracy signal | every stored date is either schema.org markup or backed by a quoted sentence checked against the source text; the split is reported |
| Deadline coverage | share of events whose source states a registration deadline |
| Deadline-alert correctness | enforced by unit tests at the 6 / 7 / 8-day boundaries (it is computed, not estimated) |
| Run completion / email delivery | status of every run, per stage, with errors |
| Digest read time | estimated from the word count of the rendered email |
| API spend | Tavily credits and Gemini calls over the last 30 days |

**What is deliberately NOT claimed.** *Time saved*, increased conversion or business ROI. The 45-minute manual search is a baseline **reported in the brief**, shown next to the digest's
estimated read time, not subtracted into a "savings" number. No link-click tracking is implemented (it would require redirect/tracking links in the email, which is intrusive); open/click tracking is not enabled.

**Risk.** "Date accuracy" cannot be measured without ground truth; the dashboard reports provenance instead of an accuracy percentage it could not back up.

---

## Check 6 - Failure risk OK? **YES, WITH GUARDRAILS**

| Risk | Control | Code / test |
| --- | --- | --- |
| Incorrect dates | Dates must be schema.org markup **or** a verbatim quote that exists in the retrieved text and actually states that day/month (contradicting years and relative phrases rejected). Otherwise the event is dropped. | `src/lib/processing/evidence.ts`, `candidates.ts` · `tests/input.test.ts` |
| Missing deadlines | Stored as `NULL`; shown as unknown; never defaulted | `tests/deadlines.test.ts`, `tests/components.test.tsx` |
| Wrong urgency | Computed in application code (`evaluateDeadline`), never by AI; exactly 7 days is **not** urgent; past deadlines are "may be closed" | `tests/deadlines.test.ts` (timezone, midnight, DST, instants) |
| Broken / unsafe links | Every URL is validated (http/https only); re-validated at render; non-http(s) never becomes a link; all text HTML-escaped in email | `urls.ts` · `tests/urls.test.ts`, `tests/digest.test.ts` |
| Duplicate events | Identity = normalized title + date + city (+ shared source URLs + fuzzy match), all sources preserved; DB unique on `dedupe_key` and `normalized_url` | `dedupe.ts` · `tests/dedupe.test.ts` |
| Irrelevant rankings | Per-item Zod validation, integers 0-100 only (never clamped), uniform-score answers discarded, matched focus areas must exist in the configured list | `rank.ts` · `tests/ai.test.ts` |
| Prompt injection from web pages | Page text wrapped as untrusted data, delimiter lookalikes stripped, system rules forbid following it, model output schema-validated and evidence-checked | `prompts.ts` |
| Inaccessible sources | Counted by reason (robots, timeout, HTTP error, ...); never replaced by invented data | `retrieval.ts`, run `stages` |
| Search / AI / DB / email outages | Each is its own stage with its own status; no fabricated replacement; DB failure fails the run and **blocks the email**; Gemini outage leaves events unscored and the email says so | `tests/pipeline.test.ts` |
| Unauthorised email runs | Cron endpoint requires `Authorization: Bearer $CRON_SECRET` (constant-time); dashboard routes require a signed HttpOnly SameSite=Strict session; mutating routes also check Origin; login is throttled in Neon | `src/lib/auth/*` · `tests/security.test.ts`, `tests/e2e/smoke.spec.ts` |
| Duplicate digests on retry | Atomic claim per ISO week (unique `run_key`), `email_status='sent'` blocks any repeat, stale-run take-over, Resend idempotency key = run + content hash | `src/lib/db/runs.ts` · `tests/db.test.ts`, `tests/pipeline.test.ts` |

**Operator choice - open dashboard.** Sign-in is required only while `ADMIN_PASSWORD` is set (`src/lib/auth/mode.ts`). The deployed demo may run with it unset so evaluators can open the dashboard without a password; in that mode the settings, manual refresh and test-send are reachable by anyone with the URL. Remaining limits: manual runs 1 per 5 min, test emails 1 per 2 min, same-origin check on every change, `CRON_SECRET` on the scheduled endpoint, and the weekly digest is idempotent per ISO week. Re-enable protection by setting `ADMIN_PASSWORD` in Vercel and redeploying.

**Residual risks (honest).** (1) A page can quote a date that is itself wrong; we guarantee the date is *what the page says*, not that the page is right.
(2) Gemini scores are judgement, not truth. (3) Vercel Hobby cron is best-effort and may run any time within the scheduled hour. (4) A Resend send whose database confirmation write fails 3 times
is reported in the run errors ("do not retry manually").

---

## Check 7 - Judgment protected? **YES**

Gemini **recommends and explains**; Vikram **decides**.

- Every event shows the 0-100 match score, the one-line reason and the original source links.
- The application never registers anyone, books travel or writes calendar entries (no calendar, map or booking integration exists).
- Footer of every email and dashboard: scores are AI decision support; confirm details on the original source; you decide whether to attend.
- The score is described as a decision signal, never as a probability of winning a client.

---

## Check 8 - ROI worth it? **LIKELY - VALIDATE**

The recurring 45-minute weekly search and the business value of events make automation plausible on a free-tier stack. This is a hypothesis to validate with the metrics in Check 5, not a claim.

**Cost controls built in** (`src/lib/config.ts`):

- At most **14 Tavily searches per run**, basic depth (1 credit each); search stops after an auth/quota error.
- At most 30 pages evaluated per run; known recent source URLs are not re-processed; pages without any date-like text never reach Gemini.
- Gemini calls are batched (4 pages or 10 events per request); stored scores are reused for 14 days unless the preferences change.
- Manual refresh is throttled (one per 5 minutes) in the database; test emails (one per 2 minutes).

**Quotas and limits to know** (verified against provider documentation on 2026-10-12; check current terms before relying on them):

| Provider | Free-plan fact | Impact |
| --- | --- | --- |
| Tavily | 1,000 credits / month; basic search = 1 credit | ~14 credits per weekly run + manual refreshes |
| Neon | Free plan: 100 CU-hours/project/month, 1 GB storage, compute suspends after 5 min idle | first request after idle is slower; storage is tiny |
| Resend | Free: 3,000 emails/month, **100/day**, 3 domains. `onboarding@resend.dev` only delivers to the Resend account owner's address | verify a domain to email anyone else (see README) |
| Vercel Hobby | Cron **once per day maximum**, fired at a random time within the scheduled hour (07:30-08:29 IST for `30 2 * * 1`); functions up to **300 s** | weekly job fits; delivery is best-effort |
| Gemini | Limits depend on model/tier and are shown in Google AI Studio | check your key's quota; the app reports quota errors |

Free hosting does not guarantee zero cost indefinitely: exceeding any quota above, or a need for exact-minute scheduling (Vercel Pro), is a paid change. Nothing in the app requires a paid upgrade silently.

---

## Check 9 - Owner clear? **DEFINED**

| Owner | Owns |
| --- | --- |
| **Vikram** (the user) | focus areas, target cities, recipient email, timezone, digest size, and every attendance / registration decision |
| **Technical operator** | API keys and quotas, the Vercel cron and its secret, database, deployment, email delivery/domain, data-quality review |

**Tools provided for each.** Vikram: the protected settings page and the digest preview/test-send. Operator: run history with every stage's outcome and error,
integration status (names only), `npm run check:integrations`, `npm run db:setup`, `docs`/README runbook, and clear error messages that name the missing variable but never print a secret.
