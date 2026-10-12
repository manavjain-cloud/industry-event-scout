import { DateTime } from "luxon";
import { LIMITS } from "@/lib/config";
import type { EventWindow } from "@/lib/dates/window";
import type { Preferences } from "@/lib/types";

export interface SearchQuery {
  id: string;
  text: string;
  /** Restrict to these domains (Tavily include_domains). */
  includeDomains?: string[];
  kind: "focus_city" | "platform_city" | "network";
}

/** Public event platforms / networks searched explicitly (named in the brief or widely used for professional events). */
const EVENT_PLATFORMS = ["eventbrite.com", "eventbrite.in", "lu.ma", "meetup.com", "10times.com", "allevents.in"];
const ISPIRT = ["ispirt.in"];

function monthPhrase(window: EventWindow): string {
  const start = DateTime.fromISO(window.start, { zone: "utc" });
  const end = DateTime.fromISO(window.end, { zone: "utc" });
  const a = start.toFormat("LLLL yyyy");
  const b = end.toFormat("LLLL yyyy");
  return a === b ? a : `${a} ${b}`;
}

/**
 * Deterministic, bounded query plan from the *saved* preferences.
 *
 * Full focus x city matrices explode quickly, so the plan:
 *  1. always includes one iSPIRT query and (up to 3) platform queries per city,
 *  2. fills the remaining budget with focus-area x city combinations ordered on
 *     diagonals so every focus area and every city is covered before any repeats,
 *  3. rotates the starting diagonal by ISO week so successive weeks explore
 *     different combinations when the matrix is larger than the budget.
 */
export function buildSearchQueries(
  prefs: Pick<Preferences, "focusAreas" | "cities">,
  window: EventWindow,
  weekNumber: number,
  maxQueries: number = LIMITS.maxQueriesPerRun,
): SearchQuery[] {
  const focus = prefs.focusAreas.filter(Boolean);
  const cities = prefs.cities.filter(Boolean);
  if (focus.length === 0 || cities.length === 0 || maxQueries <= 0) return [];

  const months = monthPhrase(window);
  const queries: SearchQuery[] = [];

  queries.push({
    id: "network-ispirt",
    kind: "network",
    text: `iSPIRT events workshops roundtables ${months}`,
    includeDomains: ISPIRT,
  });

  for (const city of cities.slice(0, 3)) {
    queries.push({
      id: `platform-${city.toLowerCase().replace(/\W+/g, "-")}`,
      kind: "platform_city",
      text: `business conference summit roundtable networking in ${city} ${months}`,
      includeDomains: EVENT_PLATFORMS,
    });
  }

  const rows = focus.length;
  const cols = cities.length;
  const diag = Math.max(rows, cols);
  const pairs: Array<{ fi: number; ci: number; order: number }> = [];
  for (let ci = 0; ci < cols; ci++) {
    for (let fi = 0; fi < rows; fi++) {
      const d = (((fi - ci + (weekNumber % diag)) % diag) + diag) % diag;
      pairs.push({ fi, ci, order: d * 1000 + ci * 10 + fi });
    }
  }
  pairs.sort((a, b) => a.order - b.order);

  for (const { fi, ci } of pairs) {
    if (queries.length >= maxQueries) break;
    queries.push({
      id: `focus-${fi}-city-${ci}`,
      kind: "focus_city",
      text: `${focus[fi]} conference OR summit OR roundtable OR meetup ${cities[ci]} ${months}`,
    });
  }

  return queries.slice(0, maxQueries);
}
