import type { EventRecord, SourceRef } from "@/lib/types";
import { canonicalCity, cityKey, titleTokens } from "./normalize";

/**
 * Event identity is NOT the URL alone: two different URLs (Eventbrite page, the
 * organiser's own site, a newsletter link) can describe one event. Records are
 * merged when any of these hold:
 *   1. they share a normalized source URL,
 *   2. they share the same dedupe key (normalized title + start date + city),
 *   3. same start date, compatible city (equal, or one unknown) and very similar titles.
 */

function tokensOf(title: string): Set<string> {
  const tokens = titleTokens(title);
  // A title made only of noise words ("Summit 2026") must still be comparable.
  return new Set(tokens.length ? tokens : title.toLowerCase().split(/\W+/).filter(Boolean));
}

export function titleSimilarity(a: string, b: string): { jaccard: number; containment: number; minSize: number } {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (!ta.size || !tb.size) return { jaccard: 0, containment: 0, minSize: 0 };
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return { jaccard: inter / union, containment: inter / Math.min(ta.size, tb.size), minSize: Math.min(ta.size, tb.size) };
}

function citiesCompatible(a: string | null, b: string | null): boolean {
  const ca = cityKey(canonicalCity(a));
  const cb = cityKey(canonicalCity(b));
  return !ca || !cb || ca === cb;
}

export function isSameEvent(a: EventRecord, b: EventRecord): boolean {
  if (a.dedupeKey === b.dedupeKey) return true;
  const urls = new Set(a.sources.map((s) => s.normalizedUrl));
  if (b.sources.some((s) => urls.has(s.normalizedUrl))) return true;
  if (a.startsOn !== b.startsOn) return false;
  if (!citiesCompatible(a.city, b.city)) return false;
  const sim = titleSimilarity(a.title, b.title);
  if (sim.jaccard >= 0.75) return true;
  // One title is a shortened form of the other ("CIO Roundtable Bengaluru" vs "CIO Roundtable").
  return sim.minSize >= 3 && sim.containment === 1 && sim.jaccard >= 0.55;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export function computeMissingFields(e: Pick<EventRecord, "city" | "venue" | "registrationUrl" | "registrationDeadline" | "registrationDeadlineAt">): string[] {
  const missing: string[] = [];
  if (!e.city) missing.push("city");
  if (!e.venue) missing.push("venue");
  if (!e.registrationUrl) missing.push("registration_url");
  if (!e.registrationDeadline && !e.registrationDeadlineAt) missing.push("registration_deadline");
  return missing;
}

function completeness(e: EventRecord): number {
  return (
    (e.id ? 100 : 0) +
    (e.dateBasis === "json_ld" ? 10 : 0) +
    (e.city ? 2 : 0) +
    (e.venue ? 2 : 0) +
    (e.registrationUrl ? 2 : 0) +
    (e.registrationDeadline ? 2 : 0) +
    (e.endsOn ? 1 : 0) +
    (e.summary ? 1 : 0)
  );
}

function mergeSources(records: EventRecord[]): SourceRef[] {
  const byUrl = new Map<string, SourceRef>();
  for (const r of records) {
    for (const s of r.sources) {
      const existing = byUrl.get(s.normalizedUrl);
      if (!existing || new Date(s.retrievedAt) > new Date(existing.retrievedAt)) byUrl.set(s.normalizedUrl, s);
    }
  }
  return [...byUrl.values()];
}

/** Merge a group of records describing the same event into one, never inventing values. */
export function mergeRecords(group: EventRecord[]): EventRecord {
  const ordered = [...group].sort((a, b) => completeness(b) - completeness(a));
  const base = ordered[0];
  const pick = <K extends keyof EventRecord>(key: K): EventRecord[K] => {
    for (const r of ordered) {
      const v = r[key];
      if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) return v;
    }
    return base[key];
  };

  // Conflicting deadlines: keep the earliest stated one so the user is never lulled into missing it.
  const deadlines = ordered.map((r) => r.registrationDeadline).filter((d): d is string => !!d).sort();
  const deadlineAts = ordered.map((r) => r.registrationDeadlineAt).filter((d): d is string => !!d).sort();
  const deadlineSource = ordered.find((r) => r.registrationDeadline === deadlines[0]) ?? base;

  const merged: EventRecord = {
    ...base,
    title: base.title,
    endsOn: pick("endsOn"),
    timeText: pick("timeText"),
    city: pick("city"),
    venue: pick("venue"),
    format: ordered.find((r) => r.format !== "unknown")?.format ?? "unknown",
    registrationUrl: pick("registrationUrl"),
    registrationDeadline: deadlines[0] ?? null,
    registrationDeadlineAt: deadlineAts[0] ?? null,
    deadlineText: deadlineSource.deadlineText ?? pick("deadlineText"),
    sourceExcerpt: pick("sourceExcerpt"),
    summary: base.summary ?? pick("summary"),
    fieldEvidence: Object.assign({}, ...[...ordered].reverse().map((r) => r.fieldEvidence)),
    sources: mergeSources(ordered),
    firstSeenAt: ordered.map((r) => r.firstSeenAt).filter((d): d is string => !!d).sort()[0] ?? null,
    lastVerifiedAt: ordered.map((r) => r.lastVerifiedAt).sort().at(-1) ?? base.lastVerifiedAt,
  };
  merged.missingFields = computeMissingFields(merged);
  return merged;
}

export interface DedupeResult {
  events: EventRecord[];
  /** How many input records were folded into another record. */
  duplicatesRemoved: number;
}

export function dedupeEvents(records: EventRecord[]): DedupeResult {
  const uf = new UnionFind(records.length);
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      if (uf.find(i) !== uf.find(j) && isSameEvent(records[i], records[j])) uf.union(i, j);
    }
  }
  const groups = new Map<number, EventRecord[]>();
  records.forEach((r, i) => {
    const root = uf.find(i);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  });
  const events = [...groups.values()].map((g) => (g.length === 1 ? g[0] : mergeRecords(g)));
  return { events, duplicatesRemoved: records.length - events.length };
}
