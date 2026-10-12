import { createHash } from "node:crypto";

/** City aliases -> canonical display name. Only used for matching, never to invent a city. */
const CITY_ALIASES: Record<string, string> = {
  bangalore: "Bengaluru",
  bengaluru: "Bengaluru",
  "bengaluru urban": "Bengaluru",
  bombay: "Mumbai",
  mumbai: "Mumbai",
  "navi mumbai": "Navi Mumbai",
  delhi: "Delhi",
  "new delhi": "Delhi",
  "ncr": "Delhi NCR",
  "delhi ncr": "Delhi NCR",
  "delhi-ncr": "Delhi NCR",
  "national capital region": "Delhi NCR",
  gurgaon: "Gurugram",
  gurugram: "Gurugram",
  noida: "Noida",
  madras: "Chennai",
  chennai: "Chennai",
  calcutta: "Kolkata",
  kolkata: "Kolkata",
  hyderabad: "Hyderabad",
  pune: "Pune",
  poona: "Pune",
  ahmedabad: "Ahmedabad",
  kochi: "Kochi",
  cochin: "Kochi",
  singapore: "Singapore",
  dubai: "Dubai",
};

/** Cities that belong to the same preference bucket ("Delhi NCR" covers its satellites). */
const CITY_GROUPS: Record<string, string[]> = {
  "Delhi NCR": ["Delhi", "Gurugram", "Noida", "Delhi NCR"],
  Mumbai: ["Navi Mumbai"],
};

export function cityKey(city: string | null | undefined): string {
  return (city ?? "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Canonical city name: alias-resolved when known, otherwise the cleaned input. Null stays null. */
export function canonicalCity(city: string | null | undefined): string | null {
  const key = cityKey(city);
  if (!key) return null;
  const alias = CITY_ALIASES[key];
  if (alias) return alias;
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** True when `eventCity` satisfies at least one of the user's `targetCities`. */
export function cityMatchesTargets(eventCity: string | null, targetCities: string[]): boolean {
  const event = canonicalCity(eventCity);
  if (!event) return false;
  for (const raw of targetCities) {
    const target = canonicalCity(raw);
    if (!target) continue;
    if (target === event) return true;
    if ((CITY_GROUPS[target] ?? []).includes(event)) return true;
    if ((CITY_GROUPS[event] ?? []).includes(target)) return true;
  }
  return false;
}

const TITLE_NOISE = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "for",
  "in",
  "at",
  "on",
  "to",
  "by",
  "with",
  "india",
  "annual",
  "edition",
  "conference",
  "summit",
  "event",
  "events",
  "meetup",
  "register",
  "registration",
  "tickets",
  "ticket",
  "eventbrite",
  "official",
  "presents",
]);

/** Tokenize a title for identity comparison: lowercase, no punctuation, no filler or year/edition words. */
export function titleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !TITLE_NOISE.has(t) && !/^(19|20)\d{2}$/.test(t) && !/^\d+(st|nd|rd|th)$/.test(t));
}

export function normalizedTitle(title: string): string {
  return titleTokens(title).join(" ");
}

export function cleanText(value: string | null | undefined, max = 300): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/** Stable identity for an event: normalized title + start date + canonical city. */
export function computeDedupeKey(title: string, startsOn: string, city: string | null): string {
  const basis = `${normalizedTitle(title)}|${startsOn}|${cityKey(canonicalCity(city))}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

export function hashPreferences(focusAreas: string[], cities: string[]): string {
  const basis = JSON.stringify({
    f: [...focusAreas].map((s) => s.trim().toLowerCase()).sort(),
    c: [...cities].map((s) => cityKey(canonicalCity(s))).sort(),
  });
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
