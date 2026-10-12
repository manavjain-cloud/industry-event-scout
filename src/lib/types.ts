export type EventFormat = "in_person" | "online" | "hybrid" | "unknown";
export type DateBasis = "json_ld" | "source_evidence";
export type RetrievalMethod = "direct" | "tavily" | "snippet";

export interface Preferences {
  recipientEmail: string | null;
  timezone: string;
  focusAreas: string[];
  cities: string[];
  windowDays: number;
  maxDigestEvents: number;
  weeklyEnabled: boolean;
  updatedAt: string;
}

export interface SourceRef {
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string | null;
  snippet: string | null;
  searchQuery: string | null;
  retrievalMethod: RetrievalMethod;
  httpStatus: number | null;
  retrievedAt: string;
}

/** A normalized, source-grounded event record. Unknown values are null, never guessed. */
export interface EventRecord {
  /** Present when the record already exists in Neon. */
  id?: string;
  dedupeKey: string;
  title: string;
  /** Local calendar dates (YYYY-MM-DD) interpreted in the user's timezone. */
  startsOn: string;
  endsOn: string | null;
  timeText: string | null;
  city: string | null;
  venue: string | null;
  format: EventFormat;
  registrationUrl: string | null;
  /** Date-only deadline (inclusive: closes at the end of that local day). */
  registrationDeadline: string | null;
  /** Exact deadline instant when the source gives a time (ISO-8601 with offset). */
  registrationDeadlineAt: string | null;
  deadlineText: string | null;
  dateBasis: DateBasis;
  /** Short source-derived excerpt used to ground ranking (not shown as fact). */
  sourceExcerpt: string | null;
  summary: string | null;
  relevanceScore: number | null;
  relevanceReason: string | null;
  matchedFocusAreas: string[];
  scoredForHash: string | null;
  scoredAt: string | null;
  /** Verbatim source quotes that support extracted fields. */
  fieldEvidence: Record<string, string>;
  missingFields: string[];
  sources: SourceRef[];
  firstSeenAt: string | null;
  lastVerifiedAt: string;
}

export type DeadlineStatus = "urgent" | "upcoming" | "expired" | "unknown";

export interface DeadlineInfo {
  status: DeadlineStatus;
  /** Whole days until the deadline; null when unknown. Negative = already passed. */
  daysRemaining: number | null;
  label: string;
}

export type RunStatus = "running" | "succeeded" | "partial" | "failed";
export type RunTrigger = "cron" | "manual" | "test_email";
export type EmailStatus = "not_applicable" | "pending" | "sending" | "sent" | "failed" | "skipped";

export interface StageResult {
  name: string;
  /** Components Map category this stage belongs to. */
  category: "TRIGGER" | "INPUT" | "CONTEXT" | "PROCESSING" | "AI" | "OUTPUT";
  status: "ok" | "partial" | "failed" | "skipped";
  durationMs: number;
  detail?: string;
  error?: string;
}

export interface RunMetrics {
  queriesPlanned: number;
  queriesSucceeded: number;
  queriesFailed: number;
  searchHits: number;
  uniqueUrls: number;
  pagesEvaluated: number;
  pagesFetchedDirect: number;
  pagesViaTavily: number;
  extractedEvents: number;
  duplicatesRemoved: number;
  outsideWindow: number;
  onlineExcluded: number;
  eventsInWindow: number;
  eventsScored: number;
  eventsUnscored: number;
  retained: number;
  urgent: number;
  eventsWithEvidenceDates: number;
  geminiCalls: number;
  tavilyCredits: number;
}

export interface RunErrorEntry {
  stage: string;
  message: string;
}
