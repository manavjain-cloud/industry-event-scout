import { LIMITS } from "@/lib/config";
import type { EmailStatus, RunErrorEntry, RunMetrics, RunStatus, RunTrigger, StageResult } from "@/lib/types";
import type { Db } from "./types";

const iso = (col: string) => `to_char(${col} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export interface RunRow {
  id: string;
  runKey: string;
  trigger: RunTrigger;
  status: RunStatus;
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  timezone: string | null;
  candidatesCount: number;
  retainedCount: number;
  urgentCount: number;
  emailStatus: EmailStatus;
  emailProviderId: string | null;
  emailError: string | null;
  emailSentAt: string | null;
  digestSubject: string | null;
  digestReadMinutes: number | null;
  isTest: boolean;
  stages: StageResult[];
  errors: RunErrorEntry[];
  metrics: Partial<RunMetrics>;
}

const RUN_COLUMNS = `
  id, run_key, trigger_source, status, attempt, ${iso("started_at")} as started_at, ${iso("finished_at")} as finished_at,
  window_start::text as window_start, window_end::text as window_end, timezone, candidates_count, retained_count,
  urgent_count, email_status, email_provider_id, email_error, ${iso("email_sent_at")} as email_sent_at,
  digest_subject, digest_read_minutes::float8 as digest_read_minutes, is_test, stages, errors, metrics`;

type RawRun = Record<string, unknown>;

function toRun(r: RawRun): RunRow {
  return {
    id: r.id as string,
    runKey: r.run_key as string,
    trigger: r.trigger_source as RunTrigger,
    status: r.status as RunStatus,
    attempt: Number(r.attempt),
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    windowStart: (r.window_start as string | null) ?? null,
    windowEnd: (r.window_end as string | null) ?? null,
    timezone: (r.timezone as string | null) ?? null,
    candidatesCount: Number(r.candidates_count),
    retainedCount: Number(r.retained_count),
    urgentCount: Number(r.urgent_count),
    emailStatus: r.email_status as EmailStatus,
    emailProviderId: (r.email_provider_id as string | null) ?? null,
    emailError: (r.email_error as string | null) ?? null,
    emailSentAt: (r.email_sent_at as string | null) ?? null,
    digestSubject: (r.digest_subject as string | null) ?? null,
    digestReadMinutes: r.digest_read_minutes === null || r.digest_read_minutes === undefined ? null : Number(r.digest_read_minutes),
    isTest: Boolean(r.is_test),
    stages: (r.stages as StageResult[]) ?? [],
    errors: (r.errors as RunErrorEntry[]) ?? [],
    metrics: (r.metrics as Partial<RunMetrics>) ?? {},
  };
}

export type ClaimResult =
  | { claimed: true; runId: string; attempt: number }
  | { claimed: false; reason: "already_sent" | "already_completed" | "in_progress"; runId: string | null };

export interface ClaimOptions {
  runKey: string;
  trigger: RunTrigger;
  isTest?: boolean;
  /** Initial email status: weekly runs are "pending", discovery-only manual runs "not_applicable". */
  emailStatus: EmailStatus;
  staleMs?: number;
}

/**
 * Atomically claim a run slot identified by `runKey`.
 *
 * Vercel Cron is best-effort and may deliver the same schedule twice (and a failed
 * invocation is not retried by Vercel, so operators may retry by hand). The unique
 * run_key plus the guarded take-over below guarantee that:
 *   - a second invocation while the first is running is refused ("in_progress"),
 *   - a week whose digest was already sent is never sent again ("already_sent"),
 *   - a failed/partial run, or one whose process died (stale "running"), can be
 *     taken over and retried - but only if no email was sent.
 */
export async function claimRun(db: Db, opts: ClaimOptions): Promise<ClaimResult> {
  const staleSeconds = (opts.staleMs ?? LIMITS.staleRunMs) / 1000;
  const inserted = await db.query<{ id: string }>(
    `insert into digest_runs (run_key, trigger_source, status, email_status, is_test)
     values ($1, $2, 'running', $3, $4)
     on conflict (run_key) do nothing
     returning id`,
    [opts.runKey, opts.trigger, opts.emailStatus, opts.isTest ?? false],
  );
  if (inserted[0]) return { claimed: true, runId: inserted[0].id, attempt: 1 };

  const takenOver = await db.query<{ id: string; attempt: number }>(
    `update digest_runs
        set status = 'running', attempt = attempt + 1, started_at = now(), finished_at = null,
            stages = '[]'::jsonb, errors = '[]'::jsonb, metrics = '{}'::jsonb,
            email_status = case when email_status = 'failed' then 'pending' else email_status end,
            email_error = null
      where run_key = $1
        and email_status <> 'sent'
        and (status in ('failed', 'partial')
             or (status = 'running' and started_at < now() - make_interval(secs => $2::float8)))
      returning id, attempt`,
    [opts.runKey, staleSeconds],
  );
  if (takenOver[0]) return { claimed: true, runId: takenOver[0].id, attempt: Number(takenOver[0].attempt) };

  const existing = await db.query<{ id: string; status: RunStatus; email_status: EmailStatus }>(
    `select id, status, email_status from digest_runs where run_key = $1`,
    [opts.runKey],
  );
  const row = existing[0];
  if (!row) return { claimed: false, reason: "in_progress", runId: null };
  if (row.email_status === "sent") return { claimed: false, reason: "already_sent", runId: row.id };
  if (row.status === "running") return { claimed: false, reason: "in_progress", runId: row.id };
  return { claimed: false, reason: "already_completed", runId: row.id };
}

export type ThrottleResult = { allowed: true; runId: string } | { allowed: false; retryAfterSeconds: number; reason: string };

/**
 * Cost-control gate for user-initiated runs. One conditional INSERT: it succeeds only
 * if no run is in flight and the previous run of this kind started outside the cooldown.
 */
export async function claimThrottledRun(
  db: Db,
  opts: { trigger: "manual" | "test_email"; cooldownMs: number; emailStatus: EmailStatus; isTest: boolean; runKey: string },
): Promise<ThrottleResult> {
  const cooldown = opts.cooldownMs / 1000;
  const stale = LIMITS.staleRunMs / 1000;
  const inserted = await db.query<{ id: string }>(
    `insert into digest_runs (run_key, trigger_source, status, email_status, is_test)
     select $1, $2, 'running', $3, $4
      where not exists (
        select 1 from digest_runs
         where (status = 'running' and started_at > now() - make_interval(secs => $6::float8))
            or (trigger_source = $2 and started_at > now() - make_interval(secs => $5::float8))
      )
     returning id`,
    [opts.runKey, opts.trigger, opts.emailStatus, opts.isTest, cooldown, stale],
  );
  if (inserted[0]) return { allowed: true, runId: inserted[0].id };

  const blocking = await db.query<{ status: RunStatus; wait: number }>(
    `select status,
            greatest(1, ceil(least(
              extract(epoch from (started_at + make_interval(secs => $2::float8)) - now()),
              case when status = 'running' then extract(epoch from (started_at + make_interval(secs => $3::float8)) - now()) else 1e9 end
            )))::int as wait
       from digest_runs
      where (status = 'running' and started_at > now() - make_interval(secs => $3::float8))
         or (trigger_source = $1 and started_at > now() - make_interval(secs => $2::float8))
      order by started_at desc limit 1`,
    [opts.trigger, cooldown, stale],
  );
  const b = blocking[0];
  return {
    allowed: false,
    retryAfterSeconds: b ? Number(b.wait) : Math.ceil(cooldown),
    reason: b?.status === "running" ? "Another run is already in progress." : "Please wait before starting another run.",
  };
}

export interface RunPatch {
  status?: RunStatus;
  finished?: boolean;
  windowStart?: string;
  windowEnd?: string;
  timezone?: string;
  candidatesCount?: number;
  retainedCount?: number;
  urgentCount?: number;
  emailStatus?: EmailStatus;
  emailProviderId?: string | null;
  emailError?: string | null;
  emailSent?: boolean;
  digestSubject?: string | null;
  digestReadMinutes?: number | null;
  stages?: StageResult[];
  errors?: RunErrorEntry[];
  metrics?: Partial<RunMetrics>;
}

export async function updateRun(db: Db, runId: string, patch: RunPatch): Promise<void> {
  await db.query(
    `update digest_runs set
       status = coalesce($2, status),
       finished_at = case when $3::boolean then now() else finished_at end,
       window_start = coalesce($4::date, window_start),
       window_end = coalesce($5::date, window_end),
       timezone = coalesce($6, timezone),
       candidates_count = coalesce($7, candidates_count),
       retained_count = coalesce($8, retained_count),
       urgent_count = coalesce($9, urgent_count),
       email_status = coalesce($10, email_status),
       email_provider_id = case when $11::boolean then $12 else email_provider_id end,
       email_error = case when $13::boolean then $14 else email_error end,
       email_sent_at = case when $15::boolean then now() else email_sent_at end,
       digest_subject = coalesce($16, digest_subject),
       digest_read_minutes = coalesce($17::numeric, digest_read_minutes),
       stages = coalesce($18::jsonb, stages),
       errors = coalesce($19::jsonb, errors),
       metrics = coalesce($20::jsonb, metrics)
     where id = $1`,
    [
      runId,
      patch.status ?? null,
      patch.finished ?? false,
      patch.windowStart ?? null,
      patch.windowEnd ?? null,
      patch.timezone ?? null,
      patch.candidatesCount ?? null,
      patch.retainedCount ?? null,
      patch.urgentCount ?? null,
      patch.emailStatus ?? null,
      patch.emailProviderId !== undefined,
      patch.emailProviderId ?? null,
      patch.emailError !== undefined,
      patch.emailError ?? null,
      patch.emailSent ?? false,
      patch.digestSubject ?? null,
      patch.digestReadMinutes ?? null,
      patch.stages ? JSON.stringify(patch.stages) : null,
      patch.errors ? JSON.stringify(patch.errors) : null,
      patch.metrics ? JSON.stringify(patch.metrics) : null,
    ],
  );
}

export interface RunEventInput {
  eventId: string;
  rank: number;
  relevanceScore: number | null;
  deadlineStatus: "urgent" | "upcoming" | "expired" | "unknown";
  daysRemaining: number | null;
}

/** Replace the run's ordered event list in one transaction (idempotent for retried runs). */
export async function saveRunEvents(db: Db, runId: string, items: RunEventInput[]): Promise<void> {
  await db.transaction([
    { text: `delete from digest_run_events where run_id = $1`, params: [runId] },
    ...(items.length
      ? [
          {
            text: `insert into digest_run_events (run_id, event_id, rank, relevance_score, deadline_status, days_remaining)
                   select $1::uuid, x.event_id, x.rank, x.relevance_score, x.deadline_status, x.days_remaining
                     from jsonb_to_recordset($2::jsonb) as x(event_id uuid, rank int, relevance_score smallint, deadline_status text, days_remaining int)`,
            params: [
              runId,
              JSON.stringify(
                items.map((i) => ({
                  event_id: i.eventId,
                  rank: i.rank,
                  relevance_score: i.relevanceScore,
                  deadline_status: i.deadlineStatus,
                  days_remaining: i.daysRemaining,
                })),
              ),
            ],
          },
        ]
      : []),
  ]);
}

export async function listRecentRuns(db: Db, limit = 15): Promise<RunRow[]> {
  const rows = await db.query<RawRun>(`select ${RUN_COLUMNS} from digest_runs order by started_at desc limit $1`, [limit]);
  return rows.map(toRun);
}

export async function getRun(db: Db, id: string): Promise<RunRow | null> {
  const rows = await db.query<RawRun>(`select ${RUN_COLUMNS} from digest_runs where id = $1::uuid`, [id]);
  return rows[0] ? toRun(rows[0]) : null;
}

/** Event ids shown by a run, in the order they were shown. */
export async function getRunEventIds(db: Db, runId: string): Promise<string[]> {
  const rows = await db.query<{ event_id: string }>(
    `select event_id from digest_run_events where run_id = $1::uuid order by rank asc`,
    [runId],
  );
  return rows.map((r) => r.event_id);
}
