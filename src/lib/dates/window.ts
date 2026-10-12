import { addDays, calendarDaysBetween, isValidIsoDate, localDate } from "./tz";

export interface EventWindow {
  /** First day of the window = today in the user's timezone. */
  start: string;
  /** Last day of the window (inclusive) = today + windowDays. */
  end: string;
  timezone: string;
  windowDays: number;
}

export function computeWindow(now: Date, tz: string, windowDays: number): EventWindow {
  const start = localDate(now, tz);
  return { start, end: addDays(start, windowDays), timezone: tz, windowDays };
}

export type WindowVerdict = "in_window" | "ended" | "too_far" | "invalid" | "series";

/**
 * Real conferences last days, not months. A listing whose start date is already past and whose end
 * date is far away is a recurring series / long-running page (start = first ever session, end = last
 * future one): its next occurrence date is unknown, so it is not presented as an ongoing event.
 */
export const MAX_EVENT_SPAN_DAYS = 14;

/**
 * An event belongs in the digest if it has not ended and starts on or before the
 * last window day. Multi-day events that began earlier but have not ended are
 * kept (they are still attendable); an unknown end date means a single-day event.
 */
export function classifyAgainstWindow(
  event: { startsOn: string; endsOn?: string | null },
  window: EventWindow,
): WindowVerdict {
  if (!isValidIsoDate(event.startsOn)) return "invalid";
  const lastDay =
    event.endsOn && isValidIsoDate(event.endsOn) && event.endsOn >= event.startsOn ? event.endsOn : event.startsOn;
  if (lastDay < window.start) return "ended";
  if (event.startsOn > window.end) return "too_far";
  if (event.startsOn < window.start && calendarDaysBetween(event.startsOn, lastDay) > MAX_EVENT_SPAN_DAYS) return "series";
  return "in_window";
}

export function isOngoing(event: { startsOn: string; endsOn?: string | null }, window: EventWindow): boolean {
  return event.startsOn < window.start && classifyAgainstWindow(event, window) === "in_window";
}

export function daysUntilStart(startsOn: string, window: EventWindow): number {
  return calendarDaysBetween(window.start, startsOn);
}

export function formatWindow(window: EventWindow): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(
      new Date(`${d}T00:00:00Z`),
    );
  return `${fmt(window.start)} - ${fmt(window.end)}, ${window.end.slice(0, 4)}`;
}
