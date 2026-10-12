import { MIN_DIGEST_RELEVANCE, URGENT_DEADLINE_DAYS, WORDS_PER_MINUTE } from "@/lib/config";
import { evaluateDeadline } from "@/lib/dates/deadlines";
import { formatDate } from "@/lib/dates/tz";
import { computeWindow, formatWindow, isOngoing, type EventWindow } from "@/lib/dates/window";
import { applyDeterministicFilters } from "@/lib/processing/filters";
import { hashPreferences } from "@/lib/processing/normalize";
import type { DeadlineInfo, EventRecord, Preferences } from "@/lib/types";
import { renderDigestHtml, renderDigestText } from "./email";

export interface DigestItem {
  event: EventRecord;
  rank: number;
  deadline: DeadlineInfo;
  ongoing: boolean;
}

export interface Digest {
  subject: string;
  intro: string;
  window: EventWindow;
  windowLabel: string;
  generatedOn: string;
  items: DigestItem[];
  /** Subset of `items` whose known deadline is fewer than 7 days away, soonest first. */
  urgent: DigestItem[];
  rankingAvailable: boolean;
  notes: string[];
  isTest: boolean;
  totalConsidered: number;
  readMinutes: number;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
  readMinutes: number;
}

function sortRanked(a: DigestItem, b: DigestItem): number {
  const sa = a.event.relevanceScore ?? -1;
  const sb = b.event.relevanceScore ?? -1;
  if (sb !== sa) return sb - sa;
  const ua = a.deadline.status === "urgent" ? 0 : 1;
  const ub = b.deadline.status === "urgent" ? 0 : 1;
  if (ua !== ub) return ua - ub;
  return a.event.startsOn.localeCompare(b.event.startsOn) || a.event.title.localeCompare(b.event.title);
}

function sortUnranked(a: DigestItem, b: DigestItem): number {
  const ua = a.deadline.status === "urgent" ? 0 : 1;
  const ub = b.deadline.status === "urgent" ? 0 : 1;
  if (ua !== ub) return ua - ub;
  return a.event.startsOn.localeCompare(b.event.startsOn) || a.event.title.localeCompare(b.event.title);
}

/**
 * Build the digest from validated records. Deadline urgency is computed here in
 * application code; Gemini only contributed score/summary/rationale upstream.
 */
export function buildDigest(
  events: EventRecord[],
  prefs: Preferences,
  now: Date,
  opts: { isTest?: boolean; notes?: string[] } = {},
): Digest {
  const window = computeWindow(now, prefs.timezone, prefs.windowDays);
  const { kept } = applyDeterministicFilters(events, window, prefs);

  const decorate = (event: EventRecord): DigestItem => ({
    event,
    rank: 0,
    deadline: evaluateDeadline({ date: event.registrationDeadline, at: event.registrationDeadlineAt }, now, prefs.timezone),
    ongoing: isOngoing(event, window),
  });
  const all = kept.map(decorate);
  const scored = all.filter((i) => i.event.relevanceScore !== null);
  const rankingAvailable = scored.length > 0 || all.length === 0;

  const notes: string[] = [...(opts.notes ?? [])];
  let pool: DigestItem[];
  if (scored.length > 0) {
    pool = scored.filter((i) => (i.event.relevanceScore ?? 0) >= MIN_DIGEST_RELEVANCE).sort(sortRanked);
    const unscored = all.length - scored.length;
    if (unscored > 0) {
      notes.push(`${unscored} event${unscored === 1 ? " was" : "s were"} not ranked by AI this time and ${unscored === 1 ? "is" : "are"} not listed here - see the dashboard.`);
    }
    const stale = scored.filter((i) => i.event.scoredForHash && i.event.scoredForHash !== hashPreferences(prefs.focusAreas, prefs.cities)).length;
    if (stale > 0) notes.push(`${stale} score${stale === 1 ? " was" : "s were"} calculated before your focus areas or cities changed; run a refresh to re-rank.`);
  } else {
    pool = [...all].sort(sortUnranked);
    if (all.length > 0) {
      notes.push("AI ranking was unavailable for this digest, so events are shown by deadline urgency and date instead of relevance. No scores were estimated.");
    }
  }

  const items = pool.slice(0, prefs.maxDigestEvents).map((item, i) => ({ ...item, rank: i + 1 }));
  const urgent = items
    .filter((i) => i.deadline.status === "urgent")
    .sort((a, b) => (a.deadline.daysRemaining ?? 99) - (b.deadline.daysRemaining ?? 99));

  const windowLabel = formatWindow(window);
  const generatedOn = formatDate(window.start, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const subjectCore = `Your Weekly Industry Event Scout | ${windowLabel}`;

  const intro =
    items.length === 0
      ? `No matching events were found for your configured focus areas and cities between ${windowLabel}. Nothing has been made up to fill the gap - check your preferences in the dashboard or try a refresh.`
      : `${items.length} event${items.length === 1 ? "" : "s"} for ${windowLabel}, ${rankingAvailable ? "ranked by how closely they match your focus areas" : "listed by urgency and date"}.${urgent.length ? ` ${urgent.length} ${urgent.length === 1 ? "has" : "have"} a registration deadline in fewer than ${URGENT_DEADLINE_DAYS} days.` : ""}`;

  const digest: Digest = {
    subject: opts.isTest ? `[TEST] ${subjectCore}` : subjectCore,
    intro,
    window,
    windowLabel,
    generatedOn,
    items,
    urgent,
    rankingAvailable,
    notes,
    isTest: Boolean(opts.isTest),
    totalConsidered: all.length,
    readMinutes: 1,
  };
  const words = renderDigestText(digest, prefs).split(/\s+/).filter(Boolean).length;
  digest.readMinutes = Math.max(1, Math.round((words / WORDS_PER_MINUTE) * 2) / 2);
  return digest;
}

export function renderDigest(digest: Digest, prefs: Preferences, appUrl?: string): Rendered {
  return {
    subject: digest.subject,
    html: renderDigestHtml(digest, prefs, appUrl),
    text: renderDigestText(digest, prefs, appUrl),
    readMinutes: digest.readMinutes,
  };
}
