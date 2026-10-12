import { DateTime } from "luxon";

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

/** YYYY-MM-DD for `instant` as seen on the wall clock of `tz`. */
export function localDate(instant: Date | string, tz: string): string {
  const dt = typeof instant === "string" ? DateTime.fromISO(instant) : DateTime.fromJSDate(instant);
  return dt.setZone(tz).toISODate() ?? "";
}

/** Validate a strict calendar date string (rejects 2026-02-30). */
export function isValidIsoDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  return DateTime.fromISO(value, { zone: "utc" }).isValid;
}

/** Whole calendar days from `a` to `b` (both YYYY-MM-DD). DST-proof (pure date arithmetic). */
export function calendarDaysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "utc" }).plus({ days }).toISODate() ?? date;
}

export function formatDate(
  date: string,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  const dt = DateTime.fromISO(date, { zone: "utc" });
  return dt.isValid ? dt.setLocale("en-IN").toLocaleString(opts) : date;
}

/** ISO week identity "2026-W42" for the local date in `tz`; used as the weekly run key. */
export function isoWeekKey(instant: Date, tz: string): string {
  const dt = DateTime.fromJSDate(instant).setZone(tz);
  return `${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
}
