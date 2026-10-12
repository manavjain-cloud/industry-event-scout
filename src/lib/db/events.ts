import type { EventRecord, SourceRef } from "@/lib/types";
import type { Db, Row } from "./types";

const iso = (col: string) => `to_char(${col} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const EVENT_COLUMNS = `
  e.id, e.dedupe_key, e.title,
  e.starts_on::text as starts_on, e.ends_on::text as ends_on, e.time_text, e.city, e.venue, e.format,
  e.registration_url, e.registration_deadline::text as registration_deadline,
  ${iso("e.registration_deadline_at")} as registration_deadline_at,
  e.deadline_text, e.date_basis, e.source_excerpt, e.summary, e.relevance_score, e.relevance_reason,
  e.matched_focus_areas, e.scored_for_hash, ${iso("e.scored_at")} as scored_at,
  e.field_evidence, e.missing_fields,
  ${iso("e.first_seen_at")} as first_seen_at, ${iso("e.last_verified_at")} as last_verified_at`;

interface EventRow extends Row {
  id: string;
  dedupe_key: string;
  title: string;
  starts_on: string;
  ends_on: string | null;
  time_text: string | null;
  city: string | null;
  venue: string | null;
  format: EventRecord["format"];
  registration_url: string | null;
  registration_deadline: string | null;
  registration_deadline_at: string | null;
  deadline_text: string | null;
  date_basis: EventRecord["dateBasis"];
  source_excerpt: string | null;
  summary: string | null;
  relevance_score: number | null;
  relevance_reason: string | null;
  matched_focus_areas: string[];
  scored_for_hash: string | null;
  scored_at: string | null;
  field_evidence: Record<string, string>;
  missing_fields: string[];
  first_seen_at: string;
  last_verified_at: string;
  sources: Array<Record<string, unknown>> | null;
}

function toRecord(row: EventRow): EventRecord {
  const sources: SourceRef[] = (row.sources ?? []).map((s) => ({
    url: String(s.url),
    normalizedUrl: String(s.normalized_url),
    domain: String(s.domain),
    title: (s.title as string | null) ?? null,
    snippet: (s.snippet as string | null) ?? null,
    searchQuery: (s.search_query as string | null) ?? null,
    retrievalMethod: s.retrieval_method as SourceRef["retrievalMethod"],
    httpStatus: s.http_status === null || s.http_status === undefined ? null : Number(s.http_status),
    retrievedAt: String(s.retrieved_at),
  }));
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    title: row.title,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    timeText: row.time_text,
    city: row.city,
    venue: row.venue,
    format: row.format,
    registrationUrl: row.registration_url,
    registrationDeadline: row.registration_deadline,
    registrationDeadlineAt: row.registration_deadline_at,
    deadlineText: row.deadline_text,
    dateBasis: row.date_basis,
    sourceExcerpt: row.source_excerpt,
    summary: row.summary,
    relevanceScore: row.relevance_score === null ? null : Number(row.relevance_score),
    relevanceReason: row.relevance_reason,
    matchedFocusAreas: row.matched_focus_areas ?? [],
    scoredForHash: row.scored_for_hash,
    scoredAt: row.scored_at,
    fieldEvidence: row.field_evidence ?? {},
    missingFields: row.missing_fields ?? [],
    sources,
    firstSeenAt: row.first_seen_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

const SOURCES_AGG = `coalesce(
  jsonb_agg(jsonb_build_object(
    'url', s.url, 'normalized_url', s.normalized_url, 'domain', s.domain, 'title', s.title,
    'snippet', s.snippet, 'search_query', s.search_query, 'retrieval_method', s.retrieval_method,
    'http_status', s.http_status, 'retrieved_at', ${iso("s.retrieved_at")}
  ) order by s.retrieved_at desc) filter (where s.id is not null), '[]'::jsonb) as sources`;

/**
 * One query returns every stored event that could still be relevant, with all of its
 * sources, so the pipeline never makes per-event round trips.
 */
export async function loadEventsOverlapping(db: Db, from: string, to: string): Promise<EventRecord[]> {
  const rows = await db.query<EventRow>(
    `select ${EVENT_COLUMNS}, ${SOURCES_AGG}
       from events e left join event_sources s on s.event_id = e.id
      where coalesce(e.ends_on, e.starts_on) >= $1::date and e.starts_on <= $2::date
      group by e.id
      order by e.starts_on asc, e.title asc`,
    [from, to],
  );
  return rows.map(toRecord);
}

/** Known source URLs retrieved recently: lets the pipeline skip re-extraction (cost control). */
export async function loadRecentSourceUrls(db: Db, sinceIso: string): Promise<Set<string>> {
  const rows = await db.query<{ normalized_url: string }>(
    `select normalized_url from event_sources where retrieved_at >= $1::timestamptz`,
    [sinceIso],
  );
  return new Set(rows.map((r) => r.normalized_url));
}

export async function loadEventsByIds(db: Db, ids: string[]): Promise<EventRecord[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<EventRow>(
    `select ${EVENT_COLUMNS}, ${SOURCES_AGG}
       from events e left join event_sources s on s.event_id = e.id
      where e.id = any($1::uuid[]) group by e.id`,
    [ids],
  );
  return rows.map(toRecord);
}

const toEventJson = (e: EventRecord) => ({
  dedupe_key: e.dedupeKey,
  title: e.title,
  starts_on: e.startsOn,
  ends_on: e.endsOn,
  time_text: e.timeText,
  city: e.city,
  venue: e.venue,
  format: e.format,
  registration_url: e.registrationUrl,
  registration_deadline: e.registrationDeadline,
  registration_deadline_at: e.registrationDeadlineAt,
  deadline_text: e.deadlineText,
  date_basis: e.dateBasis,
  source_excerpt: e.sourceExcerpt,
  summary: e.summary,
  relevance_score: e.relevanceScore,
  relevance_reason: e.relevanceReason,
  matched_focus_areas: e.matchedFocusAreas,
  scored_for_hash: e.scoredForHash,
  scored_at: e.scoredAt,
  field_evidence: e.fieldEvidence,
  missing_fields: e.missingFields,
  last_verified_at: e.lastVerifiedAt,
});

const toSourceJson = (e: EventRecord) =>
  e.sources.map((s) => ({
    dedupe_key: e.dedupeKey,
    url: s.url,
    normalized_url: s.normalizedUrl,
    domain: s.domain,
    title: s.title,
    snippet: s.snippet,
    search_query: s.searchQuery,
    retrieval_method: s.retrievalMethod,
    http_status: s.httpStatus,
    retrieved_at: s.retrievedAt,
  }));

const UPSERT_EVENTS = `
  insert into events (
    dedupe_key, title, starts_on, ends_on, time_text, city, venue, format, registration_url,
    registration_deadline, registration_deadline_at, deadline_text, date_basis, source_excerpt, summary,
    relevance_score, relevance_reason, matched_focus_areas, scored_for_hash, scored_at, field_evidence,
    missing_fields, last_verified_at
  )
  select x.dedupe_key, x.title, x.starts_on, x.ends_on, x.time_text, x.city, x.venue, x.format, x.registration_url,
         x.registration_deadline, x.registration_deadline_at, x.deadline_text, x.date_basis, x.source_excerpt, x.summary,
         x.relevance_score, x.relevance_reason,
         array(select jsonb_array_elements_text(x.matched_focus_areas)),
         x.scored_for_hash, x.scored_at, x.field_evidence,
         array(select jsonb_array_elements_text(x.missing_fields)),
         x.last_verified_at
    from jsonb_to_recordset($1::jsonb) as x(
      dedupe_key text, title text, starts_on date, ends_on date, time_text text, city text, venue text, format text,
      registration_url text, registration_deadline date, registration_deadline_at timestamptz, deadline_text text,
      date_basis text, source_excerpt text, summary text, relevance_score smallint, relevance_reason text,
      matched_focus_areas jsonb, scored_for_hash text, scored_at timestamptz, field_evidence jsonb,
      missing_fields jsonb, last_verified_at timestamptz
    )
  on conflict (dedupe_key) do update set
    title = excluded.title,
    ends_on = excluded.ends_on,
    time_text = excluded.time_text,
    city = excluded.city,
    venue = excluded.venue,
    format = excluded.format,
    registration_url = excluded.registration_url,
    registration_deadline = excluded.registration_deadline,
    registration_deadline_at = excluded.registration_deadline_at,
    deadline_text = excluded.deadline_text,
    date_basis = excluded.date_basis,
    source_excerpt = excluded.source_excerpt,
    summary = coalesce(excluded.summary, events.summary),
    relevance_score = coalesce(excluded.relevance_score, events.relevance_score),
    relevance_reason = case when excluded.relevance_score is null then events.relevance_reason else excluded.relevance_reason end,
    matched_focus_areas = case when excluded.relevance_score is null then events.matched_focus_areas else excluded.matched_focus_areas end,
    scored_for_hash = case when excluded.relevance_score is null then events.scored_for_hash else excluded.scored_for_hash end,
    scored_at = case when excluded.relevance_score is null then events.scored_at else excluded.scored_at end,
    field_evidence = excluded.field_evidence,
    missing_fields = excluded.missing_fields,
    last_verified_at = excluded.last_verified_at,
    updated_at = now()
  returning id, dedupe_key`;

const UPSERT_SOURCES = `
  insert into event_sources (event_id, url, normalized_url, domain, title, snippet, search_query, retrieval_method, http_status, retrieved_at)
  select e.id, s.url, s.normalized_url, s.domain, s.title, s.snippet, s.search_query, s.retrieval_method, s.http_status, s.retrieved_at
    from jsonb_to_recordset($1::jsonb) as s(
      dedupe_key text, url text, normalized_url text, domain text, title text, snippet text, search_query text,
      retrieval_method text, http_status integer, retrieved_at timestamptz
    )
    join events e on e.dedupe_key = s.dedupe_key
  on conflict (normalized_url) do update set
    event_id = excluded.event_id,
    title = excluded.title,
    snippet = excluded.snippet,
    retrieval_method = excluded.retrieval_method,
    http_status = excluded.http_status,
    retrieved_at = excluded.retrieved_at`;

/**
 * Persists events and their source provenance in ONE transaction (two statements,
 * regardless of how many events). Returns dedupe_key -> id. Re-running with the same
 * input is idempotent: events upsert on dedupe_key and sources on normalized_url.
 */
export async function upsertEvents(db: Db, events: EventRecord[]): Promise<Map<string, string>> {
  if (events.length === 0) return new Map();
  const results = await db.transaction([
    { text: UPSERT_EVENTS, params: [JSON.stringify(events.map(toEventJson))] },
    { text: UPSERT_SOURCES, params: [JSON.stringify(events.flatMap(toSourceJson))] },
  ]);
  const map = new Map<string, string>();
  for (const row of results[0] as Array<{ id: string; dedupe_key: string }>) map.set(row.dedupe_key, row.id);
  return map;
}
