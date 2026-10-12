import type { EventRecord, Preferences, SourceRef } from "@/lib/types";
import { computeDedupeKey } from "@/lib/processing/normalize";
import { normalizeUrl } from "@/lib/processing/urls";

export const NOW = new Date("2026-10-12T03:30:00Z"); // Monday 09:00 IST

export function makeSource(url: string, overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    url,
    normalizedUrl: normalizeUrl(url) ?? url,
    domain: new URL(url).hostname.replace(/^www\./, ""),
    title: null,
    snippet: null,
    searchQuery: "test query",
    retrievalMethod: "direct",
    httpStatus: 200,
    retrievedAt: "2026-10-12T03:00:00Z",
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  const title = overrides.title ?? "CIO Leadership Roundtable";
  const startsOn = overrides.startsOn ?? "2026-10-25";
  const city = overrides.city === undefined ? "Bengaluru" : overrides.city;
  return {
    dedupeKey: computeDedupeKey(title, startsOn, city),
    title,
    startsOn,
    endsOn: null,
    timeText: null,
    city,
    venue: "Hotel Taj Vivanta",
    format: "in_person",
    registrationUrl: "https://example.org/register",
    registrationDeadline: null,
    registrationDeadlineAt: null,
    deadlineText: null,
    dateBasis: "source_evidence",
    sourceExcerpt: "A roundtable for CIOs.",
    summary: "Roundtable for CIOs on technology leadership.",
    relevanceScore: 80,
    relevanceReason: "Matches CIO focus.",
    matchedFocusAreas: ["CIO roundtables"],
    scoredForHash: null,
    scoredAt: null,
    fieldEvidence: {},
    missingFields: [],
    sources: [makeSource("https://example.org/cio-roundtable")],
    firstSeenAt: null,
    lastVerifiedAt: "2026-10-12T03:00:00Z",
    ...overrides,
  };
}

export const PREFS: Preferences = {
  recipientEmail: "vikram@example.com",
  timezone: "Asia/Kolkata",
  focusAreas: ["CIO roundtables", "Digital transformation"],
  cities: ["Bengaluru", "Mumbai"],
  windowDays: 30,
  maxDigestEvents: 12,
  weeklyEnabled: true,
  updatedAt: "2026-10-01T00:00:00Z",
};
