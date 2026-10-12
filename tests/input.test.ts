import { describe, expect, it, vi } from "vitest";
import { buildSearchQueries } from "@/lib/input/queries";
import { parseHtml } from "@/lib/input/html";
import { extractJsonLdEvents } from "@/lib/input/jsonld";
import { fetchPublicPage, isPrivateIp, parseRobots, robotsAllows, resolvesToPublicAddress } from "@/lib/input/pageFetch";
import { SearchProviderError, dedupeHits, runSearches, tavilySearch } from "@/lib/input/tavily";
import { computeWindow } from "@/lib/dates/window";
import { buildCandidates } from "@/lib/processing/candidates";
import { evidenceInSource, evidenceSupportsDate } from "@/lib/processing/evidence";
import { PREFS, NOW } from "./helpers";
import type { PageEvidence } from "@/lib/ai/extract";

const W = computeWindow(NOW, "Asia/Kolkata", 30);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("search query planning (bounded, preference-driven)", () => {
  it("is built from the saved focus areas and cities", () => {
    const q = buildSearchQueries({ focusAreas: ["Supply chain", "Fintech"], cities: ["Pune", "Chennai"] }, W, 42);
    const text = q.map((x) => x.text).join("\n");
    expect(text).toMatch(/Supply chain/);
    expect(text).toMatch(/Fintech/);
    expect(text).toMatch(/Pune/);
    expect(text).toMatch(/Chennai/);
    expect(text).toMatch(/October 2026 November 2026/);
  });
  it("changing the preferences changes the queries", () => {
    const a = buildSearchQueries({ focusAreas: ["AI"], cities: ["Pune"] }, W, 1).map((q) => q.text);
    const b = buildSearchQueries({ focusAreas: ["Retail"], cities: ["Goa"] }, W, 1).map((q) => q.text);
    expect(a).not.toEqual(b);
    expect(b.join(" ")).toMatch(/Goa/);
  });
  it("caps the number of searches regardless of preference size", () => {
    const focus = Array.from({ length: 12 }, (_, i) => `Focus ${i}`);
    const cities = Array.from({ length: 10 }, (_, i) => `City${i}`);
    expect(buildSearchQueries({ focusAreas: focus, cities }, W, 3).length).toBeLessThanOrEqual(14);
    expect(buildSearchQueries({ focusAreas: focus, cities }, W, 3, 5)).toHaveLength(5);
  });
  it("covers every focus area and every city before repeating any", () => {
    const q = buildSearchQueries({ focusAreas: ["A1", "B2", "C3"], cities: ["X", "Y", "Z"] }, W, 0, 14).filter((x) => x.kind === "focus_city");
    const first3 = q.slice(0, 3).map((x) => x.text);
    for (const f of ["A1", "B2", "C3"]) expect(first3.some((t) => t.includes(f))).toBe(true);
    for (const c of ["X", "Y", "Z"]) expect(first3.some((t) => new RegExp(`\\b${c}\\b`).test(t))).toBe(true);
  });
  it("rotates combinations week to week and returns nothing for empty preferences", () => {
    const prefs = { focusAreas: ["A1", "B2", "C3", "D4"], cities: ["X", "Y", "Z", "Q"] };
    const w1 = buildSearchQueries(prefs, W, 1, 7).map((x) => x.id).join();
    const w2 = buildSearchQueries(prefs, W, 2, 7).map((x) => x.id).join();
    expect(w1).not.toBe(w2);
    expect(buildSearchQueries({ focusAreas: [], cities: ["X"] }, W, 1)).toEqual([]);
  });
});

describe("Tavily client - failure modes", () => {
  const q = { id: "q", text: "cio summit", kind: "focus_city" as const };
  const opts = (fetchImpl: typeof fetch) => ({ apiKey: "tvly-test-key-123", fetchImpl });

  it("parses results, drops invalid or non-event URLs and records credits", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        results: [
          { title: "Good", url: "https://www.eventbrite.com/e/1?utm_source=x", content: "snippet", score: 0.9, raw_content: "page" },
          { title: "Bad", url: "javascript:alert(1)", content: "x", score: 0.8 },
          { title: "Wiki", url: "https://en.wikipedia.org/wiki/Summit", content: "x", score: 0.7 },
        ],
        usage: { credits: 1 },
      }),
    ) as unknown as typeof fetch;
    const r = await tavilySearch(q, opts(fetchImpl));
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].normalizedUrl).toBe("https://eventbrite.com/e/1");
    expect(r.credits).toBe(1);
    const sent = JSON.parse(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent).toMatchObject({ search_depth: "basic", query: "cio summit" });
  });

  it.each([
    [401, "auth"],
    [432, "quota"],
    [433, "quota"],
    [429, "rate_limit"],
    [500, "server"],
    [400, "bad_response"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const fetchImpl = (async () => json({ detail: "x" }, status)) as unknown as typeof fetch;
    await expect(tavilySearch(q, opts(fetchImpl))).rejects.toMatchObject({ kind });
  });

  it("maps network errors, invalid JSON and wrong shapes", async () => {
    await expect(tavilySearch(q, opts((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch))).rejects.toMatchObject({ kind: "network" });
    await expect(tavilySearch(q, opts((async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch))).rejects.toMatchObject({ kind: "bad_response" });
    await expect(tavilySearch(q, opts((async () => json({ results: "nope" })) as unknown as typeof fetch))).rejects.toBeInstanceOf(SearchProviderError);
  });

  it("never puts the API key in error messages", async () => {
    const fetchImpl = (async () => { throw new Error("failed with key tvly-test-key-123"); }) as unknown as typeof fetch;
    await expect(tavilySearch(q, opts(fetchImpl))).rejects.not.toThrow(/tvly-test-key-123/);
  });

  it("continues past a failing query but stops after a fatal auth error", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return json({ results: [{ title: "ok", url: "https://a.example.com/e", content: "c", score: 1 }] });
      if (n === 2) return json({}, 500);
      return json({}, 401);
    }) as unknown as typeof fetch;
    const queries = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, text: `t${i}`, kind: "focus_city" as const }));
    const r = await runSearches(queries, { apiKey: "tvly-test-key-123", fetchImpl, concurrency: 1 });
    expect(r.succeeded).toBe(1);
    expect(r.failures.length).toBe(5);
    expect(r.failures.some((f) => f.kind === "auth")).toBe(true);
    expect(n).toBe(3); // remaining queries skipped: no wasted credits
  });

  it("de-duplicates hits by normalized URL keeping the richest content", () => {
    const base = { title: "t", domain: "a.com", snippet: "s", query: "q" };
    const out = dedupeHits([
      { ...base, url: "https://a.com/e?utm_x=1", normalizedUrl: "https://a.com/e", rawContent: null, score: 0.4 },
      { ...base, url: "https://a.com/e", normalizedUrl: "https://a.com/e", rawContent: "long raw content", score: 0.9 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rawContent: "long raw content", score: 0.9 });
  });
});

describe("public page retrieval policy", () => {
  const pub = async () => ["93.184.216.34"];

  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"])("treats %s as private", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });
  it("treats ordinary public IPs as public", () => {
    expect(isPrivateIp("93.184.216.34")).toBe(false);
  });
  it("blocks hostnames that resolve to private addresses (SSRF)", async () => {
    expect(await resolvesToPublicAddress("evil.example.com", async () => ["10.0.0.5"])).toBe(false);
    expect(await resolvesToPublicAddress("localhost")).toBe(false);
    expect(await resolvesToPublicAddress("ok.example.com", pub)).toBe(true);
  });

  it("parses robots.txt with agent-specific and wildcard groups", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/public\n");
    expect(robotsAllows(rules, "/events")).toBe(true);
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/private/public/x")).toBe(true);
    const bot = parseRobots("User-agent: IndustryEventScoutBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    expect(robotsAllows(bot, "/anything")).toBe(false);
  });

  const fetchWith = (routes: Record<string, () => Response>) =>
    (async (input: RequestInfo | URL) => {
      const u = String(input);
      for (const [k, v] of Object.entries(routes)) if (u.includes(k)) return v();
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

  it("fetches an allowed HTML page", async () => {
    const r = await fetchPublicPage("https://events.example.com/e/1", {
      resolver: pub,
      fetchImpl: fetchWith({ "robots.txt": () => new Response("User-agent: *\nAllow: /"), "/e/1": () => new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }) }),
    });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });
  it("respects robots.txt disallow", async () => {
    const r = await fetchPublicPage("https://events.example.com/e/1", {
      resolver: pub,
      fetchImpl: fetchWith({ "robots.txt": () => new Response("User-agent: *\nDisallow: /e/") }),
    });
    expect(r).toMatchObject({ ok: false, reason: "robots_disallowed" });
  });
  it("does not fetch when robots.txt itself errors (5xx)", async () => {
    const r = await fetchPublicPage("https://events.example.com/e/1", { resolver: pub, fetchImpl: fetchWith({ "robots.txt": () => new Response("x", { status: 503 }) }) });
    expect(r).toMatchObject({ ok: false, reason: "robots_unavailable" });
  });
  it("never fetches login-walled platforms or private hosts", async () => {
    const never = vi.fn() as unknown as typeof fetch;
    expect(await fetchPublicPage("https://www.linkedin.com/posts/x", { fetchImpl: never })).toMatchObject({ ok: false, reason: "blocked_domain" });
    expect(await fetchPublicPage("http://169.254.169.254/latest/meta-data", { fetchImpl: never })).toMatchObject({ ok: false, reason: "private_address" });
    expect(await fetchPublicPage("ftp://x.example.com/a", { fetchImpl: never })).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(never).not.toHaveBeenCalled();
  });
  it("re-validates redirects against the SSRF policy", async () => {
    const r = await fetchPublicPage("https://events.example.com/e/1", {
      resolver: async (h) => (h === "events.example.com" ? ["93.184.216.34"] : ["10.0.0.9"]),
      fetchImpl: fetchWith({
        "robots.txt": () => new Response("User-agent: *\nAllow: /"),
        "events.example.com/e/1": () => new Response(null, { status: 302, headers: { location: "https://internal.example.net/admin" } }),
      }),
    });
    expect(r).toMatchObject({ ok: false, reason: "private_address" });
  });
  it("rejects non-HTML content, HTTP errors and timeouts", async () => {
    const base = { resolver: pub };
    expect(await fetchPublicPage("https://e.example.com/a.pdf", { ...base, fetchImpl: fetchWith({ robots: () => new Response("", { status: 404 }), "a.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }) }) })).toMatchObject({ reason: "not_html" });
    expect(await fetchPublicPage("https://e.example.com/gone", { ...base, fetchImpl: fetchWith({ robots: () => new Response("", { status: 404 }) }) })).toMatchObject({ reason: "http_error", status: 404 });
    const timeout = (async (input: RequestInfo | URL) => {
      if (String(input).includes("robots")) return new Response("", { status: 404 });
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect(await fetchPublicPage("https://e.example.com/slow", { ...base, fetchImpl: timeout })).toMatchObject({ reason: "timeout" });
  });
});

describe("HTML and schema.org extraction", () => {
  const page = `<html><head><title> CIO &amp; CXO Summit </title><meta name="description" content="A summit"><script type="application/ld+json">
  {"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"x"},{"@type":["Event","BusinessEvent"],"name":"CIO Summit","startDate":"2026-10-25T09:00:00+05:30","endDate":"2026-10-26","location":{"@type":"Place","name":"Hotel X","address":{"addressLocality":"Mumbai"}},"eventAttendanceMode":"https://schema.org/MixedEventAttendanceMode","offers":{"url":"https://reg.example.com/x","validThrough":"2026-10-20T18:00:00+05:30"}}]}
  </script><script>var x = 1;</script></head><body><nav>menu</nav><h1>CIO Summit</h1><p>Join us on 25 &amp; 26 October.</p></body></html>`;

  it("extracts structured events and visible text only", () => {
    const parsed = parseHtml(page);
    expect(parsed.title).toBe("CIO & CXO Summit");
    expect(parsed.text).toContain("Join us on 25 & 26 October.");
    expect(parsed.text).not.toContain("var x");
    expect(parsed.text).not.toContain("menu");
    const [ev] = extractJsonLdEvents(parsed.jsonLdBlocks);
    expect(ev).toMatchObject({ name: "CIO Summit", startDate: "2026-10-25", endDate: "2026-10-26", city: "Mumbai", venue: "Hotel X", format: "hybrid", registrationUrl: "https://reg.example.com/x" });
    expect(ev.deadlineAt).toBe("2026-10-20T12:30:00.000Z");
  });
  it("ignores malformed JSON-LD instead of repairing it", () => {
    expect(extractJsonLdEvents(["{not json", "[]", '{"@type":"Event"}'])).toEqual([]);
  });
});

describe("evidence-grounded extraction (no fabricated facts)", () => {
  it("only accepts quotes that really occur in the source", () => {
    const source = "Join us on **24 October 2026** at the ITC Gardenia, Bengaluru.";
    expect(evidenceInSource("24 October 2026", source)).toBe(true);
    expect(evidenceInSource("ITC  gardenia", source)).toBe(true);
    expect(evidenceInSource("25 October 2026", source)).toBe(false);
    expect(evidenceInSource("", source)).toBe(false);
    expect(evidenceInSource("abc", source)).toBe(false);
  });
  it.each([
    ["24 October 2026", "2026-10-24", true],
    ["Oct 24th, 2026", "2026-10-24", true],
    ["24/10/2026", "2026-10-24", true],
    ["2026-10-24", "2026-10-24", true],
    ["24 October 2025", "2026-10-24", false], // contradicting year
    ["25 October 2026", "2026-10-24", false],
    ["24 November 2026", "2026-10-24", false],
    ["next Friday", "2026-10-24", false],
    ["tomorrow", "2026-10-24", false],
    ["10/24/2026", "2026-10-24", false], // ambiguous month-first reading is rejected
  ])("date evidence %s supports %s -> %s", (evidence, iso, expected) => {
    expect(evidenceSupportsDate(evidence, iso)).toBe(expected);
  });

  const page = (text: string, overrides: Partial<PageEvidence> = {}): PageEvidence => ({
    id: "p1", url: "https://e.example.com/x", normalizedUrl: "https://e.example.com/x", domain: "e.example.com", title: "t", snippet: "", text, jsonLd: [],
    retrievalMethod: "direct", httpStatus: 200, retrievedAt: NOW.toISOString(), query: "q", ...overrides,
  });
  const ai = (over: Record<string, unknown>) => ({ id: "p1", isSingleEvent: true, title: "Summit", startDate: null, endDate: null, city: null, venue: null, registrationDeadline: null, registrationUrl: null, format: "in_person" as const, ...over });

  it("drops events whose date quote is not in the page, and keeps unverifiable venue/deadline as unknown", () => {
    const p = page("The summit is on 24 October 2026. Register soon.");
    const good = buildCandidates([p], new Map([["p1", ai({ startDate: { value: "2026-10-24", evidence: "24 October 2026" }, venue: { value: "Taj Hall", evidence: "at Taj Hall" }, registrationDeadline: { value: "2026-10-10", evidence: "register by 10 October 2026" } }) as never]]), NOW.toISOString());
    expect(good).toHaveLength(1);
    expect(good[0].venue).toBeNull(); // invented venue rejected
    expect(good[0].registrationDeadline).toBeNull(); // invented deadline rejected -> unknown
    expect(good[0].missingFields).toEqual(expect.arrayContaining(["venue", "registration_deadline"]));

    const bad = buildCandidates([p], new Map([["p1", ai({ startDate: { value: "2026-10-30", evidence: "30 October 2026" } }) as never]]), NOW.toISOString());
    expect(bad).toHaveLength(0);
  });
  it("rejects a deadline that falls after the event ends", () => {
    const p = page("Summit on 24 October 2026. Register by 30 October 2026.");
    const out = buildCandidates([p], new Map([["p1", ai({ startDate: { value: "2026-10-24", evidence: "24 October 2026" }, registrationDeadline: { value: "2026-10-30", evidence: "Register by 30 October 2026" } }) as never]]), NOW.toISOString());
    expect(out[0].registrationDeadline).toBeNull();
  });
  it("skips listing pages and non-events", () => {
    const out = buildCandidates([page("A list of many events 24 October 2026")], new Map([["p1", ai({ isSingleEvent: false, startDate: { value: "2026-10-24", evidence: "24 October 2026" } }) as never]]), NOW.toISOString());
    expect(out).toHaveLength(0);
  });
  it("does not trust a JSON-LD validThrough that is not before the event starts", () => {
    const ld = { name: "E", startDate: "2026-10-24", endDate: null, city: "Pune", venue: null, format: "in_person" as const, url: null, registrationUrl: null, deadlineDate: "2026-10-24", deadlineAt: null, description: null, raw: "{}" };
    const out = buildCandidates([page("text 24 October 2026", { jsonLd: [ld] })], new Map(), NOW.toISOString());
    expect(out[0].registrationDeadline).toBeNull();
    expect(out[0].dateBasis).toBe("json_ld");
  });
});

describe("preferences fixture sanity", () => {
  it("has the shape the tests rely on", () => expect(PREFS.cities).toContain("Bengaluru"));
});
