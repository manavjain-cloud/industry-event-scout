import { LIMITS, MANUAL_BASELINE_MINUTES, MIN_DIGEST_RELEVANCE } from "@/lib/config";
import { authRequired } from "@/lib/auth/mode";
import { getDb } from "@/lib/db/client";
import { loadEventsOverlapping } from "@/lib/db/events";
import { getPreferences } from "@/lib/db/preferences";
import { listRecentRuns, type RunRow } from "@/lib/db/runs";
import type { Db } from "@/lib/db/types";
import { evaluateDeadline } from "@/lib/dates/deadlines";
import { computeWindow, formatWindow, isOngoing } from "@/lib/dates/window";
import { hasEnv, integrationStatus } from "@/lib/env";
import { errorMessage } from "@/lib/log";
import { applyDeterministicFilters, type FilterCounts } from "@/lib/processing/filters";
import { hashPreferences } from "@/lib/processing/normalize";
import { nextScheduledRun, type NextRun } from "@/lib/schedule";
import type { DeadlineInfo, EventFormat, Preferences } from "@/lib/types";

export interface DashboardEvent {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string | null;
  timeText: string | null;
  city: string | null;
  venue: string | null;
  format: EventFormat;
  registrationUrl: string | null;
  registrationDeadline: string | null;
  deadline: DeadlineInfo;
  score: number | null;
  reason: string | null;
  summary: string | null;
  matchedFocusAreas: string[];
  sources: Array<{ url: string; domain: string }>;
  missingFields: string[];
  ongoing: boolean;
  belowThreshold: boolean;
  rankingStale: boolean;
  dateBasis: "json_ld" | "source_evidence";
  lastVerifiedAt: string;
}

export interface OperationalMetrics {
  /** Weekly (cron) runs that finished, last 10. */
  weeklyRunsFinished: number;
  runsCompleted: number;
  runCompletionRate: number | null;
  emailsSent: number;
  emailDeliveryRate: number | null;
  uniqueEventsInWindow: number;
  relevantInLatestDigest: number | null;
  urgentInLatestDigest: number | null;
  duplicatesMergedLatest: number | null;
  deadlineKnownShare: number | null;
  datesFromMarkupLatest: number | null;
  datesFromQuotedEvidenceLatest: number | null;
  digestReadMinutes: number | null;
  manualBaselineMinutes: number;
  tavilyCredits30d: number;
  geminiCalls30d: number;
  latestRunDurationSeconds: number | null;
}

export interface DashboardData {
  integrations: Record<string, boolean>;
  dbReady: boolean;
  dbError: string | null;
  prefs: Preferences | null;
  windowLabel: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  events: DashboardEvent[];
  excluded: FilterCounts | null;
  runs: RunRow[];
  metrics: OperationalMetrics | null;
  nextRun: NextRun | null;
  /** A run that is genuinely in flight (not stale) so the UI can resume showing its progress. */
  activeRunId: string | null;
  /** False when the dashboard is open (no ADMIN_PASSWORD): the UI hides "Sign out". */
  authEnabled: boolean;
  generatedAt: string;
}

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 100) : null);

export function computeMetrics(runs: RunRow[], events: DashboardEvent[], now: Date): OperationalMetrics {
  const real = runs.filter((r) => !r.isTest && r.status !== "running");
  const weekly = real.filter((r) => r.trigger === "cron").slice(0, 10);
  const completed = real.filter((r) => r.status === "succeeded" || r.status === "partial");
  const latest = real.find((r) => r.metrics && Object.keys(r.metrics).length > 0) ?? null;
  const since = now.getTime() - 30 * 86_400_000;
  const recent = runs.filter((r) => Date.parse(r.startedAt) >= since && !r.isTest);
  const withDigest = real.find((r) => r.digestReadMinutes !== null);
  const sentWeekly = weekly.filter((r) => r.emailStatus === "sent").length;
  const known = events.filter((e) => e.registrationDeadline !== null).length;
  const duration = latest?.finishedAt ? Math.round((Date.parse(latest.finishedAt) - Date.parse(latest.startedAt)) / 1000) : null;

  return {
    weeklyRunsFinished: weekly.length,
    runsCompleted: completed.length,
    runCompletionRate: pct(completed.length, real.length),
    emailsSent: real.filter((r) => r.emailStatus === "sent").length,
    emailDeliveryRate: pct(sentWeekly, weekly.length),
    uniqueEventsInWindow: events.length,
    relevantInLatestDigest: latest?.metrics.retained ?? null,
    urgentInLatestDigest: latest?.metrics.urgent ?? null,
    duplicatesMergedLatest: latest?.metrics.duplicatesRemoved ?? null,
    deadlineKnownShare: pct(known, events.length),
    datesFromMarkupLatest: latest && latest.metrics.retained !== undefined ? latest.metrics.retained - (latest.metrics.eventsWithEvidenceDates ?? 0) : null,
    datesFromQuotedEvidenceLatest: latest?.metrics.eventsWithEvidenceDates ?? null,
    digestReadMinutes: withDigest?.digestReadMinutes ?? null,
    manualBaselineMinutes: MANUAL_BASELINE_MINUTES,
    tavilyCredits30d: recent.reduce((s, r) => s + (r.metrics.tavilyCredits ?? 0), 0),
    geminiCalls30d: recent.reduce((s, r) => s + (r.metrics.geminiCalls ?? 0), 0),
    latestRunDurationSeconds: duration,
  };
}

export async function loadDashboardData(db?: Db, now: Date = new Date()): Promise<DashboardData> {
  const base: DashboardData = {
    integrations: integrationStatus(),
    dbReady: false,
    dbError: null,
    prefs: null,
    windowLabel: null,
    windowStart: null,
    windowEnd: null,
    events: [],
    excluded: null,
    runs: [],
    metrics: null,
    nextRun: null,
    activeRunId: null,
    authEnabled: authRequired(),
    generatedAt: now.toISOString(),
  };
  if (!db && !hasEnv("DATABASE_URL")) return { ...base, dbError: "DATABASE_URL is not set." };

  try {
    const conn = db ?? getDb();
    const prefs = await getPreferences(conn);
    const window = computeWindow(now, prefs.timezone, prefs.windowDays);
    const [stored, runs] = await Promise.all([loadEventsOverlapping(conn, window.start, window.end), listRecentRuns(conn, 20)]);
    const { kept, counts } = applyDeterministicFilters(stored, window, prefs);
    const hash = hashPreferences(prefs.focusAreas, prefs.cities);

    const events: DashboardEvent[] = kept.map((e) => ({
      id: e.id!,
      title: e.title,
      startsOn: e.startsOn,
      endsOn: e.endsOn,
      timeText: e.timeText,
      city: e.city,
      venue: e.venue,
      format: e.format,
      registrationUrl: e.registrationUrl,
      registrationDeadline: e.registrationDeadline ?? e.registrationDeadlineAt?.slice(0, 10) ?? null,
      deadline: evaluateDeadline({ date: e.registrationDeadline, at: e.registrationDeadlineAt }, now, prefs.timezone),
      score: e.relevanceScore,
      reason: e.relevanceReason,
      summary: e.summary,
      matchedFocusAreas: e.matchedFocusAreas,
      sources: e.sources.map((s) => ({ url: s.url, domain: s.domain })),
      missingFields: e.missingFields,
      ongoing: isOngoing(e, window),
      belowThreshold: e.relevanceScore !== null && e.relevanceScore < MIN_DIGEST_RELEVANCE,
      rankingStale: e.relevanceScore !== null && e.scoredForHash !== null && e.scoredForHash !== hash,
      dateBasis: e.dateBasis,
      lastVerifiedAt: e.lastVerifiedAt,
    }));

    return {
      ...base,
      dbReady: true,
      prefs,
      windowLabel: formatWindow(window),
      windowStart: window.start,
      windowEnd: window.end,
      events,
      excluded: counts,
      runs,
      metrics: computeMetrics(runs, events, now),
      nextRun: nextScheduledRun(now, prefs.timezone),
      activeRunId: runs.find((r) => r.status === "running" && now.getTime() - Date.parse(r.startedAt) < LIMITS.staleRunMs)?.id ?? null,
    };
  } catch (err) {
    return { ...base, dbError: errorMessage(err) };
  }
}
