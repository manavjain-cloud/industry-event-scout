/**
 * Application context passed explicitly into the processing stages
 * (Components Map: CONTEXT). Brief-mandated rules live here, not in the AI.
 */

/** Digest covers the next 30 days. */
export const DEFAULT_WINDOW_DAYS = 30;

/** Registration deadlines strictly fewer than this many days away are urgent. */
export const URGENT_DEADLINE_DAYS = 7;

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/** Events scoring below this are kept in the dashboard but left out of the email. */
export const MIN_DIGEST_RELEVANCE = 40;

export const LIMITS = {
  /** Hard cap on Tavily searches per run (each costs 1 credit on the basic depth). */
  maxQueriesPerRun: 14,
  resultsPerQuery: 8,
  /** Maximum number of distinct pages evaluated per run. */
  maxPagesPerRun: 30,
  pageFetchTimeoutMs: 8_000,
  pageMaxBytes: 1_500_000,
  /** Characters of page text handed to Gemini per page. */
  pageTextMaxChars: 5_000,
  fetchConcurrency: 5,
  searchConcurrency: 4,
  extractBatchSize: 4,
  rankBatchSize: 10,
  /** Re-use a stored relevance score this long before re-scoring. */
  rescoreAfterDays: 14,
  /** Skip re-extraction of an already-known source URL for this long. */
  reuseSourceDays: 3,
  /** Vercel Hobby caps functions at 300 s; stop starting new work after this. */
  runBudgetMs: 255_000,
  /** Another manual run is refused within this window (cost control). */
  manualRunCooldownMs: 5 * 60_000,
  testEmailCooldownMs: 2 * 60_000,
  /** A run still "running" after this long is treated as dead and may be taken over. */
  staleRunMs: 10 * 60_000,
} as const;

export const WORDS_PER_MINUTE = 200;
/** The manual baseline reported by the user in the brief (not a measured saving). */
export const MANUAL_BASELINE_MINUTES = 45;
