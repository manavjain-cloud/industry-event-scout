import { isValidIsoDate } from "@/lib/dates/tz";
import { cleanText } from "@/lib/processing/normalize";
import { validateHttpUrl } from "@/lib/processing/urls";
import type { EventFormat } from "@/lib/types";

/**
 * schema.org Event markup published by the organiser is the most reliable input we
 * can get: it is structured, machine-readable and authored by the source itself.
 * Only values actually present in the markup are returned.
 */
export interface JsonLdEvent {
  name: string;
  /** Local calendar dates as published (first 10 chars of the ISO value). */
  startDate: string | null;
  endDate: string | null;
  city: string | null;
  venue: string | null;
  format: EventFormat;
  url: string | null;
  registrationUrl: string | null;
  /** offers.validThrough: date-only or exact instant. */
  deadlineDate: string | null;
  deadlineAt: string | null;
  description: string | null;
  raw: string;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = <T,>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function flatten(node: unknown, out: Obj[] = []): Obj[] {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (isObj(node)) {
    out.push(node);
    if (node["@graph"]) flatten(node["@graph"], out);
  }
  return out;
}

function isEventType(type: unknown): boolean {
  return asArray(type as string | string[]).some((t) => typeof t === "string" && /Event$/.test(t.replace(/^.*[/#]/, "")));
}

function datePart(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const d = s.slice(0, 10);
  return isValidIsoDate(d) ? d : null;
}

function hasExplicitTime(value: string): boolean {
  return /T\d{2}:\d{2}/.test(value);
}

function parseDeadline(value: unknown): { date: string | null; at: string | null } {
  const s = str(value);
  if (!s) return { date: null, at: null };
  if (hasExplicitTime(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s) && Number.isFinite(Date.parse(s))) {
    return { date: null, at: new Date(s).toISOString() };
  }
  const d = datePart(s);
  return { date: d, at: null };
}

function placeInfo(location: unknown): { city: string | null; venue: string | null; online: boolean } {
  let city: string | null = null;
  let venue: string | null = null;
  let online = false;
  for (const loc of asArray(location as unknown)) {
    if (typeof loc === "string") {
      venue ??= cleanText(loc, 200);
      continue;
    }
    if (!isObj(loc)) continue;
    if (asArray(loc["@type"] as string | string[]).some((t) => /VirtualLocation/i.test(String(t)))) {
      online = true;
      continue;
    }
    venue ??= cleanText(str(loc.name), 200);
    const addr = loc.address;
    if (typeof addr === "string") {
      venue ??= cleanText(addr, 200);
    } else if (isObj(addr)) {
      city ??= cleanText(str(addr.addressLocality) ?? str(addr.addressRegion), 80);
    }
  }
  return { city, venue, online };
}

function formatOf(mode: unknown, online: boolean, hasPlace: boolean): EventFormat {
  const m = typeof mode === "string" ? mode : isObj(mode) ? String(mode["@id"] ?? "") : "";
  if (/MixedEventAttendanceMode/i.test(m)) return "hybrid";
  if (/OnlineEventAttendanceMode/i.test(m)) return "online";
  if (/OfflineEventAttendanceMode/i.test(m)) return "in_person";
  if (online && !hasPlace) return "online";
  if (online && hasPlace) return "hybrid";
  return hasPlace ? "in_person" : "unknown";
}

export function extractJsonLdEvents(blocks: string[]): JsonLdEvent[] {
  const events: JsonLdEvent[] = [];
  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue; // malformed markup is ignored, never "repaired" into facts
    }
    for (const node of flatten(parsed)) {
      if (!isEventType(node["@type"])) continue;
      const name = cleanText(str(node.name), 200);
      if (!name) continue;
      const { city, venue, online } = placeInfo(node.location);
      const offer = asArray(node.offers as unknown).find(isObj) as Obj | undefined;
      const deadline = parseDeadline(offer?.validThrough);
      events.push({
        name,
        startDate: datePart(node.startDate),
        endDate: datePart(node.endDate),
        city,
        venue,
        format: formatOf(node.eventAttendanceMode, online, Boolean(city ?? venue)),
        url: validateHttpUrl(str(node.url)),
        registrationUrl: validateHttpUrl(str(offer?.url)),
        deadlineDate: deadline.date,
        deadlineAt: deadline.at,
        description: cleanText(str(node.description), 600),
        raw: JSON.stringify(node).slice(0, 2000),
      });
    }
  }
  return events;
}
