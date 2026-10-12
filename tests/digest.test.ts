import { describe, expect, it } from "vitest";
import { buildDigest, renderDigest } from "@/lib/output/digest";
import { esc } from "@/lib/output/email";
import { hashPreferences } from "@/lib/processing/normalize";
import { NOW, PREFS, makeEvent, makeSource } from "./helpers";

const ev = (title: string, over: Parameters<typeof makeEvent>[0] = {}) =>
  makeEvent({ title, sources: [makeSource(`https://${title.toLowerCase().replace(/\W+/g, "")}.example.com/e`)], ...over });

describe("digest assembly", () => {
  it("ranks by relevance then flags urgency from code, not from the model", () => {
    const events = [
      ev("Alpha Summit", { relevanceScore: 70, registrationDeadline: "2026-10-18" }), // 6 days -> urgent
      ev("Bravo Summit", { relevanceScore: 95, registrationDeadline: "2026-10-19" }), // exactly 7 -> NOT urgent
      ev("Charlie Summit", { relevanceScore: 60, registrationDeadline: null }),
      ev("Delta Summit", { relevanceScore: 85, registrationDeadline: "2026-10-10" }), // passed -> expired
    ];
    const d = buildDigest(events, PREFS, NOW);
    expect(d.items.map((i) => i.event.title)).toEqual(["Bravo Summit", "Delta Summit", "Alpha Summit", "Charlie Summit"]);
    expect(d.items.map((i) => i.rank)).toEqual([1, 2, 3, 4]);
    expect(Object.fromEntries(d.items.map((i) => [i.event.title, i.deadline.status]))).toEqual({
      "Alpha Summit": "urgent",
      "Bravo Summit": "upcoming",
      "Charlie Summit": "unknown",
      "Delta Summit": "expired",
    });
    expect(d.urgent.map((i) => i.event.title)).toEqual(["Alpha Summit"]);
  });

  it("applies the 30-day window, drops online-only and non-target-city events, and hides marginal matches", () => {
    const events = [
      ev("In Window", { relevanceScore: 80 }),
      ev("Past Event", { startsOn: "2026-10-01", relevanceScore: 99 }),
      ev("Too Far", { startsOn: "2026-12-25", relevanceScore: 99 }),
      ev("Webinar Only", { format: "online", city: null, relevanceScore: 99 }),
      ev("Wrong City", { city: "Kolkata", relevanceScore: 99 }),
      ev("Marginal Match", { relevanceScore: 20 }),
    ];
    expect(buildDigest(events, PREFS, NOW).items.map((i) => i.event.title)).toEqual(["In Window"]);
  });

  it("caps the list so it stays scannable", () => {
    const events = Array.from({ length: 30 }, (_, i) => ev(`Event Number ${i}`, { relevanceScore: 60 + (i % 40) }));
    const d = buildDigest(events, { ...PREFS, maxDigestEvents: 8 }, NOW);
    expect(d.items).toHaveLength(8);
    expect(d.readMinutes).toBeLessThanOrEqual(5);
  });

  it("never lets the size cap hide a closing deadline (found in live data)", () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(`Strong Event ${i}`, { relevanceScore: 95 - i }));
    const closing = ev("Closing Soon Summit", { relevanceScore: 55, registrationDeadline: "2026-10-15" });
    const lowAndClosing = ev("Irrelevant But Closing", { relevanceScore: 10, registrationDeadline: "2026-10-14" });
    const d = buildDigest([...events, closing, lowAndClosing], { ...PREFS, maxDigestEvents: 8 }, NOW);
    expect(d.items).toHaveLength(9); // 8 by rank + the urgent one beyond the cap
    expect(d.items.at(-1)?.event.title).toBe("Closing Soon Summit");
    expect(d.urgent.map((i) => i.event.title)).toEqual(["Closing Soon Summit"]);
    expect(d.items.map((i) => i.event.title)).not.toContain("Irrelevant But Closing"); // still below the relevance threshold
    expect(d.notes.join(" ")).toMatch(/added beyond your limit of 8/);
    expect(renderDigest(d, PREFS).html).toContain("Act now");
  });

  it("falls back to an honest unranked list when no event has an AI score", () => {
    const events = [ev("Later One", { relevanceScore: null, startsOn: "2026-11-05" }), ev("Sooner One", { relevanceScore: null, startsOn: "2026-10-20" }), ev("Closing One", { relevanceScore: null, startsOn: "2026-11-01", registrationDeadline: "2026-10-14" })];
    const d = buildDigest(events, PREFS, NOW);
    expect(d.rankingAvailable).toBe(false);
    expect(d.items.map((i) => i.event.title)).toEqual(["Closing One", "Sooner One", "Later One"]);
    expect(d.notes.join(" ")).toMatch(/AI ranking was unavailable/);
    expect(renderDigest(d, PREFS).html).not.toMatch(/Match \d+\/100/);
  });

  it("notes events that were not ranked and scores that predate a preference change", () => {
    const stale = ev("Stale Score", { relevanceScore: 80, scoredForHash: "old-hash" });
    const fresh = ev("Fresh Score", { relevanceScore: 75, scoredForHash: hashPreferences(PREFS.focusAreas, PREFS.cities) });
    const unscored = ev("Unscored One", { relevanceScore: null });
    const d = buildDigest([stale, fresh, unscored], PREFS, NOW);
    expect(d.notes.join(" ")).toMatch(/not ranked by AI/);
    expect(d.notes.join(" ")).toMatch(/before your focus areas or cities changed/);
  });

  it("handles an empty result set gracefully without inventing events", () => {
    const d = buildDigest([], PREFS, NOW);
    const r = renderDigest(d, PREFS);
    expect(d.items).toHaveLength(0);
    expect(d.rankingAvailable).toBe(true);
    expect(r.html).toContain("No matching events were found");
    expect(r.text).toContain("No matching events were found");
    expect(r.subject).toBe(`Your Weekly Industry Event Scout | ${d.windowLabel}`);
  });

  it("labels test sends in the subject and body", () => {
    const r = renderDigest(buildDigest([ev("X Summit")], PREFS, NOW, { isTest: true }), PREFS);
    expect(r.subject.startsWith("[TEST] ")).toBe(true);
    expect(r.html).toContain("TEST SEND");
    expect(r.text).toContain("TEST SEND");
  });
});

describe("email content", () => {
  const urgentEvent = ev("Urgent Roundtable", { relevanceScore: 90, registrationDeadline: "2026-10-15", registrationUrl: "https://reg.example.com/ur" });
  const unknownEvent = ev("Mystery Meetup", { relevanceScore: 70, venue: null, city: null, registrationDeadline: null, registrationUrl: null });

  it("shows the urgency warning with text and an icon, not colour alone", () => {
    const r = renderDigest(buildDigest([urgentEvent, unknownEvent], PREFS, NOW), PREFS);
    expect(r.html).toContain("&#9888;"); // warning sign
    expect(r.html).toContain("REGISTRATION CLOSES IN 3 DAYS");
    expect(r.html).toContain("Act now");
    expect(r.text).toContain("!! ACT NOW");
    expect(r.text).toContain("Registration closes in 3 days".toUpperCase());
  });

  it("displays unknown values as unavailable instead of omitting them", () => {
    const r = renderDigest(buildDigest([unknownEvent], PREFS, NOW), PREFS);
    expect(r.text).toContain("City unavailable");
    expect(r.text).toContain("Venue unavailable");
    expect(r.text).toMatch(/deadline: not published \/ unavailable/i);
  });

  it("includes original source and registration links, and falls back to the source when no registration URL is known", () => {
    const r = renderDigest(buildDigest([urgentEvent, unknownEvent], PREFS, NOW), PREFS);
    expect(r.html).toContain('href="https://reg.example.com/ur"');
    expect(r.html).toContain("Original source");
    expect(r.html).toContain("Event page"); // mystery meetup: only the source page is known
  });

  it("escapes untrusted event text and never renders non-http(s) links", () => {
    const evil = ev("<script>alert(1)</script> Summit", {
      relevanceScore: 90,
      venue: '"><img src=x onerror=alert(1)>',
      summary: "Click <a href='https://evil.example'>here</a>",
      registrationUrl: "javascript:alert(1)",
      sources: [makeSource("https://safe.example.com/e")],
    });
    const r = renderDigest(buildDigest([evil], PREFS, NOW), PREFS);
    expect(r.html).not.toContain("<script>alert");
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).not.toContain("javascript:");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("escapes HTML special characters", () => {
    expect(esc(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  it("is mobile-friendly and has a plain-text alternative with the same events", () => {
    const d = buildDigest([urgentEvent, unknownEvent], PREFS, NOW);
    const r = renderDigest(d, PREFS, "https://scout.example.com");
    expect(r.html).toMatch(/name="viewport"/);
    expect(r.html).toMatch(/max-width:640px/);
    expect(r.text).toContain("Urgent Roundtable");
    expect(r.text).toContain("Mystery Meetup");
    expect(r.text).toContain("https://scout.example.com");
  });
});
