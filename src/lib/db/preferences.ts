import { DEFAULT_TIMEZONE, DEFAULT_WINDOW_DAYS } from "@/lib/config";
import type { PreferencesInput } from "@/lib/schemas";
import type { Preferences } from "@/lib/types";
import type { Db } from "./types";

/**
 * Editable starting points only. They are NOT facts about the user: the dashboard
 * replaces them, and nothing is hard-coded elsewhere.
 */
export const DEFAULT_FOCUS_AREAS = [
  "CIO and CXO roundtables",
  "Digital transformation",
  "Startup ecosystem and investor meetups",
  "Management consulting and business strategy",
];
export const DEFAULT_CITIES = ["Bengaluru", "Mumbai", "Delhi NCR"];

const COLUMNS = `recipient_email, timezone, focus_areas, cities, window_days, max_digest_events, weekly_enabled,
  to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as updated_at`;

interface PreferencesRow {
  recipient_email: string | null;
  timezone: string;
  focus_areas: string[];
  cities: string[];
  window_days: number;
  max_digest_events: number;
  weekly_enabled: boolean;
  updated_at: string;
}

function fromRow(row: PreferencesRow): Preferences {
  return {
    recipientEmail: row.recipient_email,
    timezone: row.timezone,
    focusAreas: row.focus_areas,
    cities: row.cities,
    windowDays: Number(row.window_days),
    maxDigestEvents: Number(row.max_digest_events),
    weeklyEnabled: row.weekly_enabled,
    updatedAt: row.updated_at,
  };
}

/** Loads the single preferences row, creating it with editable defaults on first use. */
export async function getPreferences(db: Db): Promise<Preferences> {
  await db.query(
    `insert into user_preferences (id, timezone, focus_areas, cities, window_days)
     values (1, $1, $2, $3, $4) on conflict (id) do nothing`,
    [DEFAULT_TIMEZONE, DEFAULT_FOCUS_AREAS, DEFAULT_CITIES, DEFAULT_WINDOW_DAYS],
  );
  const rows = await db.query<PreferencesRow>(`select ${COLUMNS} from user_preferences where id = 1`);
  return fromRow(rows[0]);
}

export async function savePreferences(db: Db, input: PreferencesInput): Promise<Preferences> {
  const rows = await db.query<PreferencesRow>(
    `insert into user_preferences (id, recipient_email, timezone, focus_areas, cities, window_days, max_digest_events, weekly_enabled)
     values (1, $1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do update set
       recipient_email = excluded.recipient_email,
       timezone = excluded.timezone,
       focus_areas = excluded.focus_areas,
       cities = excluded.cities,
       window_days = excluded.window_days,
       max_digest_events = excluded.max_digest_events,
       weekly_enabled = excluded.weekly_enabled,
       updated_at = now()
     returning ${COLUMNS}`,
    [
      input.recipientEmail,
      input.timezone,
      input.focusAreas,
      input.cities,
      input.windowDays,
      input.maxDigestEvents,
      input.weeklyEnabled,
    ],
  );
  return fromRow(rows[0]);
}
