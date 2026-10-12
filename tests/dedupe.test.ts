import { describe, expect, it } from "vitest";
import { dedupeEvents, isSameEvent, titleSimilarity } from "@/lib/processing/dedupe";
import { canonicalCity, cityMatchesTargets, computeDedupeKey } from "@/lib/processing/normalize";
import { makeEvent, makeSource } from "./helpers";

describe("event deduplication across different URLs", () => {
  it("merges the same event announced on three different sites", () => {
    const eventbrite = makeEvent({
      title: "CIO Leadership Roundtable 2026",
      city: "Bengaluru",
      venue: null,
      registrationDeadline: null,
      sources: [makeSource("https://www.eventbrite.com/e/cio-leadership-roundtable-tickets-123")],
    });
    const organiser = makeEvent({
      title: "The CIO Leadership Roundtable",
      city: "Bangalore",
      venue: "ITC Gardenia",
      registrationDeadline: "2026-10-20",
      sources: [makeSource("https://cioforum.example.com/roundtable")],
    });
    const newsletter = makeEvent({
      title: "CIO Leadership Roundtable - Bengaluru",
      city: null,
      sources: [makeSource("https://newsletter.example.net/issue-42")],
    });

    const { events, duplicatesRemoved } = dedupeEvents([eventbrite, organiser, newsletter]);
    expect(events).toHaveLength(1);
    expect(duplicatesRemoved).toBe(2);

    const merged = events[0];
    expect(merged.sources.map((s) => s.domain).sort()).toEqual([
      "cioforum.example.com",
      "eventbrite.com",
      "newsletter.example.net",
    ]);
    // Merging keeps every useful field that any source provided - and invents none.
    expect(merged.venue).toBe("ITC Gardenia");
    expect(merged.registrationDeadline).toBe("2026-10-20");
    expect(merged.missingFields).not.toContain("venue");
  });

  it("merges records that share a normalized URL even when titles differ", () => {
    const a = makeEvent({ title: "Alpha Summit", sources: [makeSource("https://x.example.com/ev?utm_source=mail")] });
    const b = makeEvent({ title: "Totally Different Name", startsOn: "2026-10-26", sources: [makeSource("https://www.x.example.com/ev/#top")] });
    expect(isSameEvent(a, b)).toBe(true);
  });

  it("does NOT merge different events that merely share a city or a date", () => {
    const a = makeEvent({ title: "Fintech Founders Meetup", sources: [makeSource("https://a.example.com/1")] });
    const b = makeEvent({ title: "Healthcare Leaders Summit", sources: [makeSource("https://b.example.com/2")] });
    const c = makeEvent({ title: "Fintech Founders Meetup", startsOn: "2026-10-26", sources: [makeSource("https://c.example.com/3")] });
    const { events } = dedupeEvents([a, b, c]);
    expect(events).toHaveLength(3);
  });

  it("does not merge same-titled events in clearly different cities", () => {
    const blr = makeEvent({ title: "CXO Summit", city: "Bengaluru", sources: [makeSource("https://a.example.com/1")] });
    const mum = makeEvent({ title: "CXO Summit", city: "Mumbai", sources: [makeSource("https://b.example.com/2")] });
    expect(dedupeEvents([blr, mum]).events).toHaveLength(2);
  });

  it("prefers an already-stored record (with id) as the merge base", () => {
    const stored = makeEvent({ id: "11111111-1111-1111-1111-111111111111", sources: [makeSource("https://a.example.com/1")] });
    const fresh = makeEvent({ sources: [makeSource("https://b.example.com/2")], venue: "Somewhere else" });
    const { events } = dedupeEvents([fresh, stored]);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(stored.id);
    expect(events[0].dedupeKey).toBe(stored.dedupeKey);
  });

  it("keeps the earliest deadline when sources disagree (never lulls the user)", () => {
    const a = makeEvent({ registrationDeadline: "2026-10-22", sources: [makeSource("https://a.example.com/1")] });
    const b = makeEvent({ registrationDeadline: "2026-10-18", sources: [makeSource("https://b.example.com/2")] });
    expect(dedupeEvents([a, b]).events[0].registrationDeadline).toBe("2026-10-18");
  });

  it("returns an empty list for empty input", () => {
    expect(dedupeEvents([])).toEqual({ events: [], duplicatesRemoved: 0 });
  });
});

describe("normalization helpers", () => {
  it("resolves common city aliases", () => {
    expect(canonicalCity("Bangalore")).toBe("Bengaluru");
    expect(canonicalCity("  new   delhi ")).toBe("Delhi");
    expect(canonicalCity("")).toBeNull();
    expect(canonicalCity(null)).toBeNull();
  });
  it("matches events to target cities including NCR groups", () => {
    expect(cityMatchesTargets("Bangalore", ["Bengaluru"])).toBe(true);
    expect(cityMatchesTargets("Gurugram", ["Delhi NCR"])).toBe(true);
    expect(cityMatchesTargets("Pune", ["Bengaluru", "Mumbai"])).toBe(false);
    expect(cityMatchesTargets(null, ["Bengaluru"])).toBe(false);
  });
  it("produces a stable dedupe key independent of casing, punctuation and year words", () => {
    expect(computeDedupeKey("CIO Roundtable 2026!", "2026-10-25", "Bangalore")).toBe(
      computeDedupeKey("cio roundtable", "2026-10-25", "Bengaluru"),
    );
    expect(computeDedupeKey("CIO Roundtable", "2026-10-26", "Bengaluru")).not.toBe(
      computeDedupeKey("CIO Roundtable", "2026-10-25", "Bengaluru"),
    );
  });
  it("computes title similarity", () => {
    expect(titleSimilarity("CIO Roundtable", "CIO Roundtable").jaccard).toBe(1);
    expect(titleSimilarity("AI Summit", "Wine Tasting").jaccard).toBe(0);
  });
});
