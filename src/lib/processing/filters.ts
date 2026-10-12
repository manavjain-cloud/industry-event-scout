import { classifyAgainstWindow, type EventWindow } from "@/lib/dates/window";
import type { EventRecord, Preferences } from "@/lib/types";
import { cityMatchesTargets } from "./normalize";

export interface FilterCounts {
  ended: number;
  series: number;
  tooFar: number;
  invalidDate: number;
  online: number;
  outsideTargetCities: number;
}

export interface FilterResult {
  kept: EventRecord[];
  counts: FilterCounts;
}

/**
 * Deterministic filters run BEFORE any Gemini ranking so no tokens are spent on events
 * that cannot be in the digest:
 *  - date window (not ended, starts within the window),
 *  - online-only events (the product is about in-person networking),
 *  - events whose KNOWN city is not one of the target cities. Unknown cities are kept:
 *    the data does not support a location decision, so it is left to ranking.
 */
export function applyDeterministicFilters(
  events: EventRecord[],
  window: EventWindow,
  prefs: Pick<Preferences, "cities">,
): FilterResult {
  const counts: FilterCounts = { ended: 0, series: 0, tooFar: 0, invalidDate: 0, online: 0, outsideTargetCities: 0 };
  const kept: EventRecord[] = [];
  for (const e of events) {
    const verdict = classifyAgainstWindow(e, window);
    if (verdict === "ended") counts.ended += 1;
    else if (verdict === "series") counts.series += 1;
    else if (verdict === "too_far") counts.tooFar += 1;
    else if (verdict === "invalid") counts.invalidDate += 1;
    else if (e.format === "online") counts.online += 1;
    else if (e.city && !cityMatchesTargets(e.city, prefs.cities)) counts.outsideTargetCities += 1;
    else kept.push(e);
  }
  return { kept, counts };
}
