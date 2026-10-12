# Components Map: as implemented

The course structure is **TRIGGER → INPUT → CONTEXT → PROCESSING → AI → OUTPUT**
(`industry_event_scout_components_map.jpg`). This page documents the system **as built**; the stage names below are the
literal stage names the pipeline records in `digest_runs.stages` and shows in the dashboard's *Runs & metrics* tab.

> The map lists CONTEXT as step 3 (what the system needs to interpret the inputs). In the running pipeline the context is
> loaded first - the preferences define the queries - and its values (window, deadline rule, ranking criteria) are then passed *explicitly* into the
> later stages, exactly as the map describes.

```mermaid
flowchart TD
  subgraph TRIGGER["01 TRIGGER"]
    T1["Vercel Cron<br/>Mondays 02:30 UTC (vercel.json)"]
    T2["GET /api/cron/weekly-digest<br/>Bearer CRON_SECRET"]
    T3["POST /api/runs (manual refresh)<br/>POST /api/digest/test-email<br/>session cookie + origin check + throttle"]
    T1 --> T2
  end

  subgraph CONTEXT["03 CONTEXT (Neon PostgreSQL)"]
    C1[("user_preferences<br/>focus areas, cities, email, timezone")]
    C2[("events + event_sources<br/>history, provenance, scores")]
    C3["Rules passed explicitly:<br/>30-day window - deadline under 7 days - ranking criteria"]
  end

  subgraph INPUT["02 INPUT"]
    I1["Query plan from saved preferences<br/>(max 14 searches)"]
    I2["Tavily search<br/>titles, snippets, URLs, page text"]
    I3["Public page fetch<br/>robots.txt, SSRF guard, timeouts, size cap<br/>+ schema.org Event markup"]
  end

  subgraph PROCESSING["04 PROCESSING (plain code)"]
    P1["Normalize + validate candidates<br/>URLs, dates, city aliases, evidence checks"]
    P2["De-duplicate<br/>title + date + city, shared URLs, fuzzy match"]
    P3["Window + location filters<br/>drop ended / out-of-window / online / wrong city"]
  end

  subgraph AI["05 AI - Gemini Flash only"]
    A1["Extract facts from pages<br/>structured JSON, quoted evidence"]
    A2["Score 0-100, reason, summary,<br/>matched focus areas"]
  end

  subgraph OUTPUT["06 OUTPUT"]
    O1["Validate AI output (Zod)<br/>deadline urgency computed in code"]
    O2[("Neon: events, sources,<br/>digest_runs, digest_run_events")]
    O3["Resend: ranked HTML + text digest"]
    O4["Dashboard: events, preview,<br/>settings, run history"]
  end

  T2 --> C1
  T3 --> C1
  C1 --> I1 --> I2 --> I3
  C2 -. "already-known URLs skipped<br/>stored events merged" .-> P2
  C3 -. rules .-> P3
  C3 -. rules .-> O1
  I3 --> A1 --> P1 --> P2 --> P3 --> A2 --> O1
  O1 --> O2
  O1 --> O3
  O2 --> O4
  O3 -- "status + provider id" --> O2
```

## Stage-by-stage (code ↔ map)

| Map step | Recorded stage name | What it does | Code |
| --- | --- | --- | --- |
| **01 TRIGGER** | `cron trigger` / `manual trigger` | Vercel Cron calls the weekly endpoint (UTC schedule `30 2 * * 1` = Monday 08:00 IST, best effort). A protected manual run and a protected test-email action exist for development. The endpoint rejects anything without the exact `CRON_SECRET`; manual routes need the signed session; each is idempotent / throttled. | `vercel.json`, `src/app/api/cron/weekly-digest/route.ts`, `src/app/api/runs/route.ts`, `src/lib/auth/guard.ts`, `src/lib/db/runs.ts` (`claimRun`, `claimThrottledRun`) |
| **02 INPUT** | `search (Tavily)` | Bounded queries built from the saved focus areas × cities, plus iSPIRT and event-platform queries. Titles, snippets, URLs and extracted page text come back from Tavily. Failures are counted per query; auth/quota errors stop the rest. | `src/lib/input/queries.ts`, `src/lib/input/tavily.ts` |
| | `retrieve public event pages` | Fetches accessible public pages (schema.org `Event` JSON-LD + text). Respects robots.txt, never fetches login-walled platforms, blocks private addresses, 8 s / 1.5 MB limits. Falls back to Tavily's page text, then the snippet. Unpublished facts stay unknown. | `src/lib/input/pageFetch.ts`, `html.ts`, `jsonld.ts`, `src/lib/pipeline/retrieval.ts` |
| **03 CONTEXT** | `load preferences and stored events` | One round trip each for preferences, stored in-window events (with all sources) and recently seen source URLs. Computes the 30-day window in the user's timezone. | `src/lib/db/preferences.ts`, `events.ts`, `src/lib/dates/window.ts`, `src/lib/config.ts` |
| **04 PROCESSING** | `normalize and validate candidates` | Merges schema.org data with evidence-checked AI output into source-grounded records; unverifiable dates drop the event, unverifiable venue / city / deadline become *unknown*. | `src/lib/processing/candidates.ts`, `evidence.ts`, `normalize.ts`, `urls.ts` |
| | `deduplicate and apply filters` | Merges repeats (identity = normalized title + date + city, shared URLs, fuzzy match) while preserving every source; removes ended / out-of-window events; applies location and online filters when the data supports them. | `src/lib/processing/dedupe.ts`, `filters.ts` |
| **05 AI / GEMINI FLASH** | `extract event facts (Gemini)` | Batched structured extraction (`responseJsonSchema`), each fact accompanied by a verbatim quote that code then verifies. Page text is untrusted data. | `src/lib/ai/extract.ts`, `prompts.ts`, `schemas.ts`, `llm.ts` |
| | `rank relevance (Gemini)` | Score (integer 0-100), one-line rationale, short factual summary, matched focus areas. Per-item Zod validation, retries only the missing ids, discards uniform scores, never clamps. | `src/lib/ai/rank.ts` |
| **06 OUTPUT** | `persist events and digest` | Validates the final records, **calculates deadline urgency in code**, builds the ranked digest, and stores events, sources and the ordered run list in Neon in a single transaction. | `src/lib/output/digest.ts`, `src/lib/dates/deadlines.ts`, `src/lib/db/events.ts` |
| | `send digest (Resend)` | Renders a responsive HTML + plain-text email and submits it with a Resend idempotency key. `email_status = sent` is written only after Resend accepts the message. | `src/lib/output/email.ts`, `mailer.ts`, `src/lib/pipeline/run.ts` |
| | Dashboard | Review events (sort/filter), deadline states, settings, digest preview, manual refresh, run history with stage errors. | `src/app/dashboard/page.tsx`, `src/components/dashboard/*` |

## Run outcome rules

| Situation | Run status | Email |
| --- | --- | --- |
| Everything ok, email accepted by Resend | `succeeded` | `sent` |
| Email accepted, but a stage degraded (some searches failed, some events unranked, Gemini down...) | `partial` | `sent`, with the problem listed |
| Email not sent for any reason (Resend error, no recipient, DB write failed) | `failed` | `failed` / `skipped` (error stored) |
| A `failed`/`partial` weekly run whose email was **not** sent, retried the same ISO week | taken over, `attempt + 1` | sent once |
| Same week, email already sent (duplicate cron delivery, manual retry) | untouched | **never sent twice** |

## Data model (Neon)

```mermaid
erDiagram
  events ||--o{ event_sources : "has provenance"
  digest_runs ||--o{ digest_run_events : "shows"
  events ||--o{ digest_run_events : "shown in"
  user_preferences {
    smallint id PK "always 1"
    text recipient_email
    text timezone
    text_array focus_areas
    text_array cities
  }
  events {
    uuid id PK
    text dedupe_key UK
    date starts_on
    date registration_deadline "NULL means unknown"
    smallint relevance_score "0 to 100"
    text date_basis "json_ld or source_evidence"
  }
  event_sources {
    uuid id PK
    uuid event_id FK
    text normalized_url UK
    text retrieval_method
  }
  digest_runs {
    uuid id PK
    text run_key UK "weekly:2026-W42"
    text status
    text email_status
    jsonb stages
    jsonb errors
    jsonb metrics
  }
  digest_run_events {
    uuid run_id FK
    uuid event_id FK
    int rank "unique per run"
  }
```

Schema: [`db/migrations/001_init.sql`](../db/migrations/001_init.sql), applied by `npm run db:setup`.

## What was deliberately left out (scope cuts)

No map or calendar integration, no auto-registration, no second AI provider, no paid scraping, no link-click tracking, no user accounts beyond the single protected dashboard.
