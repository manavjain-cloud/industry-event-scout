import { DateTime } from "luxon";

/** Must match vercel.json: Mondays 02:30 UTC (= 08:00 India Standard Time). */
export const CRON_SCHEDULE = "30 2 * * 1";
export const CRON_WEEKDAY = 1; // Monday (luxon: 1 = Monday)
export const CRON_HOUR_UTC = 2;
export const CRON_MINUTE_UTC = 30;

export interface NextRun {
  iso: string;
  label: string;
  /** Hobby plans run cron "anywhere within the scheduled hour" (Vercel docs). */
  windowLabel: string;
}

export function nextScheduledRun(now: Date, timezone: string): NextRun {
  const base = DateTime.fromJSDate(now, { zone: "utc" });
  let next = base.set({ weekday: CRON_WEEKDAY, hour: CRON_HOUR_UTC, minute: CRON_MINUTE_UTC, second: 0, millisecond: 0 });
  if (next <= base) next = next.plus({ weeks: 1 });
  const local = next.setZone(timezone);
  const hourStart = next.set({ minute: 0 }).setZone(timezone);
  const hourEnd = next.set({ minute: 59 }).setZone(timezone);
  return {
    iso: next.toISO() ?? "",
    label: `${local.toFormat("ccc d LLL yyyy, h:mm a")} ${local.offsetNameShort ?? ""}`.trim(),
    windowLabel: `${hourStart.toFormat("h:mm a")} - ${hourEnd.toFormat("h:mm a")}`,
  };
}
