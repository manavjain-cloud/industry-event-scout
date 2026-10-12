import type { ExtractItem } from "@/lib/ai/schemas";
import type { PageEvidence } from "@/lib/ai/extract";
import { isValidIsoDate } from "@/lib/dates/tz";
import type { JsonLdEvent } from "@/lib/input/jsonld";
import type { EventRecord, SourceRef } from "@/lib/types";
import { computeMissingFields } from "./dedupe";
import { evidenceInSource, evidenceSupportsDate, urlInSource } from "./evidence";
import { canonicalCity, cleanText, computeDedupeKey } from "./normalize";
import { domainOf, normalizeUrl, validateHttpUrl } from "./urls";

export interface CandidateStats {
  pagesWithoutEvent: number;
  rejectedDates: number;
  rejectedDeadlines: number;
  rejectedVenueOrCity: number;
  fromJsonLd: number;
  fromEvidence: number;
}

export function emptyStats(): CandidateStats {
  return { pagesWithoutEvent: 0, rejectedDates: 0, rejectedDeadlines: 0, rejectedVenueOrCity: 0, fromJsonLd: 0, fromEvidence: 0 };
}

function sourceFor(page: PageEvidence, url: string): SourceRef {
  return {
    url,
    normalizedUrl: normalizeUrl(url) ?? page.normalizedUrl,
    domain: domainOf(url) || page.domain,
    title: cleanText(page.title, 200),
    snippet: cleanText(page.snippet, 400),
    searchQuery: page.query,
    retrievalMethod: page.retrievalMethod,
    httpStatus: page.httpStatus,
    retrievedAt: page.retrievedAt,
  };
}

/** Accept an AI-quoted fact only if the quote exists in the source. */
function verified(field: { value: string; evidence: string } | null | undefined, page: PageEvidence): { value: string; evidence: string } | null {
  if (!field?.value || !field.evidence) return null;
  const haystack = `${page.text}\n${page.snippet}\n${page.title}`;
  return evidenceInSource(field.evidence, haystack) ? field : null;
}

function verifiedDate(field: ExtractItem["startDate"], page: PageEvidence): { value: string; evidence: string } | null {
  const ok = verified(field, page);
  if (!ok || !isValidIsoDate(ok.value) || !evidenceSupportsDate(ok.evidence, ok.value)) return null;
  return ok;
}

function excerptFor(page: PageEvidence, description: string | null): string | null {
  return cleanText(description || page.snippet || page.text.slice(0, 600), 700);
}

function build(args: {
  page: PageEvidence;
  sourceUrl: string;
  title: string;
  startsOn: string;
  endsOn: string | null;
  city: string | null;
  venue: string | null;
  format: EventRecord["format"];
  registrationUrl: string | null;
  deadlineDate: string | null;
  deadlineAt: string | null;
  deadlineText: string | null;
  dateBasis: EventRecord["dateBasis"];
  excerpt: string | null;
  evidence: Record<string, string>;
  now: string;
}): EventRecord {
  const city = canonicalCity(args.city);
  const record: EventRecord = {
    dedupeKey: computeDedupeKey(args.title, args.startsOn, city),
    title: args.title,
    startsOn: args.startsOn,
    endsOn: args.endsOn && args.endsOn >= args.startsOn ? args.endsOn : null,
    timeText: null,
    city,
    venue: args.venue,
    format: args.format,
    registrationUrl: args.registrationUrl,
    registrationDeadline: args.deadlineDate,
    registrationDeadlineAt: args.deadlineAt,
    deadlineText: args.deadlineText,
    dateBasis: args.dateBasis,
    sourceExcerpt: args.excerpt,
    summary: null,
    relevanceScore: null,
    relevanceReason: null,
    matchedFocusAreas: [],
    scoredForHash: null,
    scoredAt: null,
    fieldEvidence: args.evidence,
    missingFields: [],
    sources: [sourceFor(args.page, args.sourceUrl)],
    firstSeenAt: null,
    lastVerifiedAt: args.now,
  };
  record.missingFields = computeMissingFields(record);
  return record;
}

/**
 * Merge structured source data (JSON-LD) with evidence-verified Gemini output into
 * source-grounded EventRecords. Nothing unverifiable survives: an unverified date drops
 * the event; an unverified venue, city or deadline becomes null ("unknown").
 *
 * Deadlines are additionally sanity-checked: a registration deadline after the event's
 * last day is impossible, and a JSON-LD offers.validThrough is only trusted when it is
 * strictly before the event starts (it is frequently just the event date).
 */
export function buildCandidates(
  pages: PageEvidence[],
  extraction: Map<string, ExtractItem>,
  nowIso: string,
  stats: CandidateStats = emptyStats(),
): EventRecord[] {
  const out: EventRecord[] = [];

  for (const page of pages) {
    const ai = extraction.get(page.id);
    const ldEvents = page.jsonLd.filter((e) => e.startDate);

    if (ldEvents.length > 0) {
      // A page with several JSON-LD events is a listing: keep only events with their own distinct URL.
      const usable: JsonLdEvent[] =
        ldEvents.length === 1
          ? ldEvents
          : ldEvents.filter((e) => e.url && normalizeUrl(e.url) !== page.normalizedUrl);
      for (const ld of usable) {
        const startsOn = ld.startDate!;
        const endsOn = ld.endDate;
        const lastDay = endsOn && endsOn >= startsOn ? endsOn : startsOn;

        let deadlineDate = ld.deadlineDate && ld.deadlineDate < startsOn ? ld.deadlineDate : null;
        const deadlineAt = ld.deadlineAt && ld.deadlineAt.slice(0, 10) < startsOn ? ld.deadlineAt : null;
        const evidence: Record<string, string> = { startDate: "schema.org Event markup (startDate)" };
        if (deadlineDate || deadlineAt) evidence.registrationDeadline = "schema.org Event markup (offers.validThrough)";

        let city = ld.city;
        let venue = ld.venue;
        const aiSingle = ldEvents.length === 1 && ai?.isSingleEvent ? ai : null;

        if (!deadlineDate && !deadlineAt && aiSingle) {
          const d = verifiedDate(aiSingle.registrationDeadline, page);
          if (d && d.value <= lastDay) {
            deadlineDate = d.value;
            evidence.registrationDeadline = d.evidence;
          } else if (aiSingle.registrationDeadline) stats.rejectedDeadlines += 1;
        }
        if (aiSingle) {
          if (!city) {
            const c = verified(aiSingle.city, page);
            if (c) {
              city = c.value;
              evidence.city = c.evidence;
            } else if (aiSingle.city) stats.rejectedVenueOrCity += 1;
          }
          if (!venue) {
            const v = verified(aiSingle.venue, page);
            if (v) {
              venue = cleanText(v.value, 200);
              evidence.venue = v.evidence;
            } else if (aiSingle.venue) stats.rejectedVenueOrCity += 1;
          }
        }

        const sourceUrl = validateHttpUrl(ldEvents.length > 1 ? ld.url : page.url) ?? page.url;
        out.push(
          build({
            page,
            sourceUrl,
            title: ld.name,
            startsOn,
            endsOn,
            city,
            venue,
            format: ld.format,
            registrationUrl: ld.registrationUrl,
            deadlineDate,
            deadlineAt,
            deadlineText: evidence.registrationDeadline ?? null,
            dateBasis: "json_ld",
            excerpt: excerptFor(page, ld.description),
            evidence,
            now: nowIso,
          }),
        );
        stats.fromJsonLd += 1;
      }
      continue;
    }

    if (!ai || !ai.isSingleEvent || !ai.title) {
      stats.pagesWithoutEvent += 1;
      continue;
    }
    const start = verifiedDate(ai.startDate, page);
    if (!start) {
      stats.rejectedDates += 1; // no verifiable date => not a usable event; never guess one
      continue;
    }
    const evidence: Record<string, string> = { startDate: start.evidence };
    const end = verifiedDate(ai.endDate, page);
    const endsOn = end && end.value >= start.value ? end.value : null;
    if (endsOn && end) evidence.endDate = end.evidence;
    const lastDay = endsOn ?? start.value;

    let deadlineDate: string | null = null;
    if (ai.registrationDeadline) {
      const d = verifiedDate(ai.registrationDeadline, page);
      if (d && d.value <= lastDay) {
        deadlineDate = d.value;
        evidence.registrationDeadline = d.evidence;
      } else stats.rejectedDeadlines += 1;
    }
    const cityV = verified(ai.city, page);
    const venueV = verified(ai.venue, page);
    if ((ai.city && !cityV) || (ai.venue && !venueV)) stats.rejectedVenueOrCity += 1;
    if (cityV) evidence.city = cityV.evidence;
    if (venueV) evidence.venue = venueV.evidence;
    const registrationUrl = urlInSource(ai.registrationUrl, `${page.text}\n${page.url}`) ? validateHttpUrl(ai.registrationUrl) : null;

    out.push(
      build({
        page,
        sourceUrl: page.url,
        title: cleanText(ai.title, 200)!,
        startsOn: start.value,
        endsOn,
        city: cityV?.value ?? null,
        venue: venueV ? cleanText(venueV.value, 200) : null,
        format: ai.format,
        registrationUrl,
        deadlineDate,
        deadlineAt: null,
        deadlineText: evidence.registrationDeadline ?? null,
        dateBasis: "source_evidence",
        excerpt: excerptFor(page, null),
        evidence,
        now: nowIso,
      }),
    );
    stats.fromEvidence += 1;
  }
  return out;
}
