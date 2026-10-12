import { URGENT_DEADLINE_DAYS } from "@/lib/config";
import type { DeadlineInfo } from "@/lib/types";
import { calendarDaysBetween, isValidIsoDate, localDate } from "./tz";

const DAY_MS = 86_400_000;
const EXPIRED_LABEL = "Registration deadline has passed - may be closed";

export interface DeadlineInput {
  /** Date-only deadline, inclusive of that whole local day. */
  date?: string | null;
  /** Exact deadline instant (ISO-8601 with offset/Z), when the source gives a time. */
  at?: string | null;
}

/**
 * Deterministic registration-deadline evaluation. Gemini never touches this.
 *
 * Rules (strictly "fewer than 7 days"):
 *  - date-only: days = calendar days from today (in `tz`) to the deadline day.
 *      days < 0            -> expired
 *      0 <= days < 7       -> urgent   (0 = closes today)
 *      days >= 7           -> upcoming (exactly 7 is NOT urgent)
 *  - exact instant: remaining = at - now.
 *      remaining <= 0      -> expired
 *      remaining < 7 x 24h -> urgent
 *      otherwise           -> upcoming
 *  - nothing known         -> unknown (never defaulted to a date)
 */
export function evaluateDeadline(
  input: DeadlineInput | null | undefined,
  now: Date,
  tz: string,
  thresholdDays: number = URGENT_DEADLINE_DAYS,
): DeadlineInfo {
  const at = input?.at ? Date.parse(input.at) : NaN;
  if (Number.isFinite(at)) {
    const remainingMs = at - now.getTime();
    if (remainingMs <= 0) {
      return { status: "expired", daysRemaining: -Math.ceil(-remainingMs / DAY_MS), label: EXPIRED_LABEL };
    }
    const days = Math.floor(remainingMs / DAY_MS);
    if (remainingMs < thresholdDays * DAY_MS) {
      return { status: "urgent", daysRemaining: days, label: closesLabel(days) };
    }
    return { status: "upcoming", daysRemaining: days, label: `Registration closes in ${days} days` };
  }

  if (isValidIsoDate(input?.date)) {
    const days = calendarDaysBetween(localDate(now, tz), input.date);
    if (days < 0) return { status: "expired", daysRemaining: days, label: EXPIRED_LABEL };
    if (days < thresholdDays) return { status: "urgent", daysRemaining: days, label: closesLabel(days) };
    return { status: "upcoming", daysRemaining: days, label: `Registration closes in ${days} days` };
  }

  return { status: "unknown", daysRemaining: null, label: "Registration deadline not published / unknown" };
}

function closesLabel(days: number): string {
  if (days <= 0) return "Registration closes TODAY";
  if (days === 1) return "Registration closes in 1 day";
  return `Registration closes in ${days} days`;
}
