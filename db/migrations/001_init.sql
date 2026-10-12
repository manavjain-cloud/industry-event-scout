-- Industry Event Scout: initial schema (Components Map: CONTEXT / OUTPUT storage).
-- Plain statements separated by semicolons; no procedural bodies, so the same
-- file runs on Neon (via scripts/db-setup.mjs) and on PGlite in the test-suite.

create table if not exists user_preferences (
  id                smallint primary key default 1 check (id = 1),     -- single-user app: exactly one row
  recipient_email   text,
  timezone          text not null default 'Asia/Kolkata',
  focus_areas       text[] not null default '{}',
  cities            text[] not null default '{}',
  window_days       smallint not null default 30 check (window_days between 7 and 60),
  max_digest_events smallint not null default 12 check (max_digest_events between 3 and 25),
  weekly_enabled    boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists events (
  id                        uuid primary key default gen_random_uuid(),
  dedupe_key                text not null unique,                      -- sha256(normalized title | start date | canonical city)
  title                     text not null,
  starts_on                 date not null,
  ends_on                   date,
  time_text                 text,
  city                      text,
  venue                     text,
  format                    text not null default 'unknown' check (format in ('in_person', 'online', 'hybrid', 'unknown')),
  registration_url          text,
  registration_deadline     date,                                      -- NULL = unknown, never a placeholder date
  registration_deadline_at  timestamptz,                               -- only when the source states an exact time
  deadline_text             text,
  date_basis                text not null check (date_basis in ('json_ld', 'source_evidence')),
  source_excerpt            text,
  summary                   text,
  relevance_score           smallint check (relevance_score between 0 and 100),
  relevance_reason          text,
  matched_focus_areas       text[] not null default '{}',
  scored_for_hash           text,                                      -- hash of the preferences used for the score
  scored_at                 timestamptz,
  field_evidence            jsonb not null default '{}'::jsonb,
  missing_fields            text[] not null default '{}',
  first_seen_at             timestamptz not null default now(),
  last_verified_at          timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint events_end_not_before_start check (ends_on is null or ends_on >= starts_on)
);

create index if not exists events_starts_on_idx on events (starts_on);
create index if not exists events_relevance_idx on events (relevance_score desc nulls last);

-- One event can be announced in many places; every useful source is preserved.
create table if not exists event_sources (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references events (id) on delete cascade,
  url               text not null,
  normalized_url    text not null unique,
  domain            text not null,
  title             text,
  snippet           text,
  search_query      text,
  retrieval_method  text not null check (retrieval_method in ('direct', 'tavily', 'snippet')),
  http_status       integer,
  retrieved_at      timestamptz not null default now()
);

create index if not exists event_sources_event_idx on event_sources (event_id);

create table if not exists digest_runs (
  id                 uuid primary key default gen_random_uuid(),
  run_key            text not null unique,                             -- weekly:<ISO week> | manual:<uuid> | test:<uuid>
  trigger_source     text not null check (trigger_source in ('cron', 'manual', 'test_email')),
  status             text not null check (status in ('running', 'succeeded', 'partial', 'failed')),
  attempt            integer not null default 1,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  window_start       date,
  window_end         date,
  timezone           text,
  candidates_count   integer not null default 0,
  retained_count     integer not null default 0,
  urgent_count       integer not null default 0,
  email_status       text not null default 'not_applicable'
                       check (email_status in ('not_applicable', 'pending', 'sending', 'sent', 'failed', 'skipped')),
  email_provider_id  text,
  email_error        text,
  email_sent_at      timestamptz,
  digest_subject     text,
  digest_read_minutes numeric(4, 1),
  is_test            boolean not null default false,
  stages             jsonb not null default '[]'::jsonb,
  errors             jsonb not null default '[]'::jsonb,
  metrics            jsonb not null default '{}'::jsonb
);

create index if not exists digest_runs_started_idx on digest_runs (started_at desc);

-- Which events a run showed, in the order they were shown, with a snapshot of the ranking.
create table if not exists digest_run_events (
  run_id           uuid not null references digest_runs (id) on delete cascade,
  event_id         uuid not null references events (id) on delete cascade,
  rank             integer not null check (rank >= 1),
  relevance_score  smallint check (relevance_score between 0 and 100),
  deadline_status  text not null check (deadline_status in ('urgent', 'upcoming', 'expired', 'unknown')),
  days_remaining   integer,
  primary key (run_id, event_id),
  unique (run_id, rank)
);

-- Login throttling that survives serverless cold starts (stores a hash, never the IP).
create table if not exists auth_attempts (
  id            bigserial primary key,
  ip_hash       text not null,
  succeeded     boolean not null,
  attempted_at  timestamptz not null default now()
);

create index if not exists auth_attempts_lookup_idx on auth_attempts (ip_hash, attempted_at desc);
