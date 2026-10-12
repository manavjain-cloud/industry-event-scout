import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { LlmClient, LlmRequest } from "@/lib/ai/llm";
import { LlmError } from "@/lib/ai/llm";
import { savePreferences } from "@/lib/db/preferences";
import type { Db, SqlStatement } from "@/lib/db/types";
import type { PageFetchOutcome } from "@/lib/input/pageFetch";
import type { SearchHit, SearchRunResult } from "@/lib/input/tavily";
import { MailError, type Mailer, type MailMessage } from "@/lib/output/mailer";
import type { PipelineDeps } from "@/lib/pipeline/deps";
import { runWeeklyDigest, sendTestEmail, startManualRun } from "@/lib/pipeline/entrypoints";
import { preferencesInputSchema } from "@/lib/schemas";
import { normalizeUrl } from "@/lib/processing/urls";
import { NOW } from "./helpers";
import { createTestDb, failingDb } from "./pgdb";

let db: Db;
let pg: PGlite;

beforeEach(async () => {
  ({ db, pg } = await createTestDb());
  await savePreferences(
    db,
    preferencesInputSchema.parse({
      recipientEmail: "vikram@example.com",
      timezone: "Asia/Kolkata",
      focusAreas: ["CIO roundtables"],
      cities: ["Bengaluru"],
      windowDays: 30,
      maxDigestEvents: 12,
      weeklyEnabled: true,
    }),
  );
});
afterEach(async () => {
  await pg.close();
});

// ---------------------------------------------------------------- fixtures
const hit = (url: string, score: number, extra: Partial<SearchHit> = {}): SearchHit => ({
  title: "Event page",
  url,
  normalizedUrl: normalizeUrl(url)!,
  domain: new URL(url).hostname.replace(/^www\./, ""),
  snippet: "Event snippet text that is long enough to be meaningful for the tests.",
  rawContent: null,
  score,
  query: "q",
  ...extra,
});

const searchOk = (hits: SearchHit[]): SearchRunResult => ({ hits, failures: [], succeeded: 3, credits: 3 });

const html = (body: string, ld?: object) =>
  `<html><head><title>T</title>${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ""}</head><body><p>${body}</p></body></html>`;

const ok = (url: string, markup: string): PageFetchOutcome => ({ ok: true, url, finalUrl: url, status: 200, html: markup });

function fakeLlm(handlers: { extract?: (req: LlmRequest) => unknown; rank?: (req: LlmRequest) => unknown }) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async generateJson(req) {
      calls.push(req);
      const handler = req.label === "extract" ? handlers.extract : handlers.rank;
      if (!handler) throw new LlmError("no handler", "unknown");
      return handler(req);
    },
  };
  return { client, calls };
}

const idsIn = (prompt: string, prefix: "PAGE" | "EVENT") => [...prompt.matchAll(new RegExp(`### ${prefix} (\\w+)`, "g"))].map((m) => m[1]);

const rankAll = (scores: number[]) => (req: LlmRequest) => ({
  results: idsIn(req.prompt, "EVENT").map((id, i) => ({
    id,
    relevanceScore: scores[i % scores.length],
    relevanceReason: "Strong overlap with CIO roundtables in the target city.",
    summary: "A roundtable where CIOs discuss technology leadership.",
    matchedFocusAreas: ["CIO roundtables"],
  })),
});

function fakeMailer(behaviour: "ok" | "fail" = "ok") {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    async send(msg) {
      if (behaviour === "fail") throw new MailError("Resend server error: boom", "server", 500);
      sent.push(msg);
      return { id: `re_${sent.length}` };
    },
  };
  return { mailer, sent };
}

function makeDeps(over: Partial<PipelineDeps> & { llm: LlmClient; mailer: Mailer }): PipelineDeps {
  return {
    db,
    search: vi.fn(async () => searchOk([])),
    fetchPage: vi.fn(async (url: string) => ({ ok: false, url, reason: "network", message: "offline" }) as PageFetchOutcome),
    now: () => NOW,
    ...over,
  };
}

const EVENT_LD = {
  "@context": "https://schema.org",
  "@type": "Event",
  name: "CIO Leadership Roundtable",
  startDate: "2026-10-24",
  location: { "@type": "Place", name: "ITC Gardenia", address: { "@type": "PostalAddress", addressLocality: "Bangalore" } },
  eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
  offers: { "@type": "Offer", url: "https://register.example.com/cio" },
};

const runRow = async (id: string) => (await pg.query<Record<string, unknown>>("select * from digest_runs where id = $1", [id])).rows[0];

// ------------------------------------------------------------------- tests
describe("weekly pipeline - happy path with live-shaped data (mocked services)", () => {
  it("discovers, de-duplicates, grounds, ranks, flags the deadline and emails exactly once", async () => {
    const hits = [
      hit("https://www.eventbrite.com/e/cio-roundtable-1", 0.9),
      hit("https://cioforum.example.com/roundtable", 0.8),
      hit("https://old.example.com/past", 0.7),
      hit("https://liar.example.com/event", 0.6),
    ];
    const pages: Record<string, string> = {
      "https://www.eventbrite.com/e/cio-roundtable-1": html("Join CIOs for a leadership roundtable on 24 October 2026 in Bengaluru. Register by 18 October 2026.", EVENT_LD),
      "https://cioforum.example.com/roundtable": html("CIO Leadership Roundtable, 24 October 2026, ITC Gardenia, Bangalore."),
      "https://old.example.com/past": html("Annual CIO summit held on 3 September 2026 in Bengaluru."),
      "https://liar.example.com/event": html("An event is coming soon, details to follow. Stay tuned for 2026 updates this year."),
    };
    const llm = fakeLlm({
      extract: (req) => ({
        results: idsIn(req.prompt, "PAGE").map((id) => {
          const url = /url: (\S+)/.exec(req.prompt.split(`### PAGE ${id}`)[1])![1];
          if (url.includes("eventbrite"))
            return { id, isSingleEvent: true, title: "CIO Leadership Roundtable", startDate: null, endDate: null, city: null, venue: null, registrationUrl: null, format: "in_person", registrationDeadline: { value: "2026-10-18", evidence: "Register by 18 October 2026" } };
          if (url.includes("cioforum"))
            return { id, isSingleEvent: true, title: "The CIO Leadership Roundtable 2026", startDate: { value: "2026-10-24", evidence: "24 October 2026" }, endDate: null, city: { value: "Bangalore", evidence: "ITC Gardenia, Bangalore" }, venue: { value: "ITC Gardenia", evidence: "ITC Gardenia" }, registrationDeadline: null, registrationUrl: null, format: "in_person" };
          if (url.includes("old"))
            return { id, isSingleEvent: true, title: "Annual CIO Summit", startDate: { value: "2026-09-03", evidence: "3 September 2026" }, endDate: null, city: null, venue: null, registrationDeadline: null, registrationUrl: null, format: "in_person" };
          // fabricated date with an invented quote that is NOT in the page
          return { id, isSingleEvent: true, title: "Phantom Summit", startDate: { value: "2026-10-30", evidence: "30 October 2026 at the Grand Hall" }, endDate: null, city: null, venue: null, registrationDeadline: null, registrationUrl: null, format: "in_person" };
        }),
      }),
      rank: rankAll([88]),
    });
    const { mailer, sent } = fakeMailer();
    const deps = makeDeps({
      llm: llm.client,
      mailer,
      search: vi.fn(async () => searchOk(hits)),
      fetchPage: vi.fn(async (url: string) => ok(url, pages[url])),
    });

    const result = await runWeeklyDigest(deps);
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") return;
    expect(result.summary.status).toBe("succeeded");
    expect(result.summary.emailStatus).toBe("sent");

    // Two listings of the same event merged; past and fabricated ones rejected.
    const stored = (await pg.query<{ title: string; city: string; venue: string; registration_deadline: string | null }>(
      "select title, city, venue, registration_deadline::text from events order by title",
    )).rows;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ city: "Bengaluru", venue: "ITC Gardenia", registration_deadline: "2026-10-18" });
    const sources = (await pg.query<{ n: number }>("select count(*)::int n from event_sources")).rows[0].n;
    expect(sources).toBe(2); // both announcements preserved as provenance

    // Exactly one email, containing the deadline flag computed in code (6 days away).
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Your Weekly Industry Event Scout \| /);
    expect(sent[0].html).toContain("Registration closes in 6 days".toUpperCase());
    expect(sent[0].html).toContain("Match 88/100");
    expect(sent[0].text).toContain("!! ");
    expect(sent[0].html).not.toContain("Phantom Summit");

    const run = await runRow(result.summary.runId);
    expect(run).toMatchObject({ status: "succeeded", email_status: "sent", email_provider_id: "re_1", retained_count: 1, urgent_count: 1 });
    expect((await pg.query("select 1 from digest_run_events where run_id = $1", [result.summary.runId])).rows).toHaveLength(1);
    const stages = (run.stages as Array<{ category: string }>).map((s) => s.category);
    expect(new Set(stages)).toEqual(new Set(["TRIGGER", "CONTEXT", "INPUT", "AI", "PROCESSING", "OUTPUT"]));
  });
});

describe("weekly pipeline - empty and failing inputs never fabricate events", () => {
  it("handles an empty search result set gracefully and says so in the email", async () => {
    const llm = fakeLlm({ extract: () => ({ results: [] }), rank: rankAll([50]) });
    const { mailer, sent } = fakeMailer();
    const result = await runWeeklyDigest(makeDeps({ llm: llm.client, mailer, search: vi.fn(async () => searchOk([])) }));
    expect(result.outcome === "completed" && result.summary.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("No matching events were found");
    expect(sent[0].text).toContain("No matching events were found");
    expect((await pg.query("select 1 from events")).rows).toHaveLength(0);
    expect(llm.calls).toHaveLength(0); // nothing to extract or rank, no Gemini spend
  });

  it("reports a search-provider failure honestly and invents nothing", async () => {
    const llm = fakeLlm({ extract: () => ({ results: [] }), rank: rankAll([50]) });
    const { mailer, sent } = fakeMailer();
    const failed: SearchRunResult = { hits: [], succeeded: 0, credits: 0, failures: [{ queryId: "q1", message: "Tavily rejected the API key (401).", kind: "auth" }] };
    const result = await runWeeklyDigest(makeDeps({ llm: llm.client, mailer, search: vi.fn(async () => failed) }));
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.summary.status).toBe("partial");
    expect(result.summary.errors.some((e) => e.message.includes("Tavily rejected"))).toBe(true);
    expect((await pg.query("select 1 from events")).rows).toHaveLength(0);
    expect(sent[0].html).toContain("Live search failed this week");
    const run = await runRow(result.summary.runId);
    expect((run.stages as Array<{ name: string; status: string }>).find((s) => s.name.startsWith("search"))?.status).toBe("failed");
  });

  it("keeps schema.org events but shows the ranking failure when Gemini is unavailable (no fake scores)", async () => {
    const llm: LlmClient = { generateJson: async () => { throw new LlmError("Gemini quota or rate limit reached", "quota"); } };
    const { mailer, sent } = fakeMailer();
    const url = "https://www.eventbrite.com/e/cio-roundtable-1";
    const result = await runWeeklyDigest(
      makeDeps({ llm, mailer, search: vi.fn(async () => searchOk([hit(url, 0.9)])), fetchPage: vi.fn(async (u: string) => ok(u, html("CIO roundtable on 24 October 2026.", EVENT_LD))) }),
    );
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.summary.status).toBe("partial");
    const row = (await pg.query<{ relevance_score: number | null }>("select relevance_score from events")).rows;
    expect(row).toHaveLength(1);
    expect(row[0].relevance_score).toBeNull(); // never fabricated
    expect(sent[0].html).toContain("AI ranking was unavailable");
    expect(sent[0].html).not.toContain("Match ");
    const stages = (await runRow(result.summary.runId)).stages as Array<{ name: string; status: string }>;
    expect(stages.find((s) => s.name.startsWith("rank"))?.status).toBe("failed");
  });
});

describe("weekly pipeline - delivery failures are recorded, never reported as success", () => {
  const url = "https://www.eventbrite.com/e/cio-roundtable-1";
  const base = () => {
    const llm = fakeLlm({ extract: () => ({ results: [] }), rank: rankAll([80]) });
    return { llm: llm.client, search: vi.fn(async () => searchOk([hit(url, 0.9)])), fetchPage: vi.fn(async (u: string) => ok(u, html("CIO roundtable on 24 October 2026.", EVENT_LD))) };
  };

  it("marks the run failed and stores the Resend error when delivery fails", async () => {
    const { mailer } = fakeMailer("fail");
    const result = await runWeeklyDigest(makeDeps({ ...base(), mailer }));
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.summary).toMatchObject({ status: "failed", emailStatus: "failed" });
    const run = await runRow(result.summary.runId);
    expect(run).toMatchObject({ status: "failed", email_status: "failed" });
    expect(String(run.email_error)).toContain("Resend server error");
    expect(run.email_sent_at).toBeNull();
  });

  it("allows a retry after a failed delivery, then refuses a duplicate once it was sent", async () => {
    const failing = fakeMailer("fail");
    const first = await runWeeklyDigest(makeDeps({ ...base(), mailer: failing.mailer }));
    if (first.outcome !== "completed") throw new Error("expected completed");

    const good = fakeMailer("ok");
    const retry = await runWeeklyDigest(makeDeps({ ...base(), mailer: good.mailer }));
    expect(retry.outcome).toBe("completed");
    if (retry.outcome === "completed") {
      expect(retry.summary.runId).toBe(first.summary.runId); // same weekly run, attempt 2
      expect(retry.summary.emailStatus).toBe("sent");
    }
    expect(good.sent).toHaveLength(1);

    // Vercel Cron delivering the same schedule twice must not send a second digest.
    const dup = await runWeeklyDigest(makeDeps({ ...base(), mailer: good.mailer }));
    expect(dup).toMatchObject({ outcome: "skipped", reason: "already_sent" });
    expect(good.sent).toHaveLength(1);
    expect((await pg.query("select attempt from digest_runs where trigger_source='cron'")).rows[0]).toMatchObject({ attempt: 2 });
  });

  it("two simultaneous cron deliveries send one digest", async () => {
    const { mailer, sent } = fakeMailer();
    const mk = () => makeDeps({ ...base(), mailer });
    const [a, b] = await Promise.all([runWeeklyDigest(mk()), runWeeklyDigest(mk())]);
    expect([a.outcome, b.outcome].sort()).toEqual(["completed", "skipped"]);
    expect(sent).toHaveLength(1);
  });

  it("does not send (and fails the run) when results cannot be persisted to the database", async () => {
    const flaky: Db = {
      query: (text, params) => db.query(text, params),
      transaction: async (statements: SqlStatement[]) => {
        void statements;
        throw new Error("Neon: connection terminated");
      },
    };
    const { mailer, sent } = fakeMailer();
    const result = await runWeeklyDigest(makeDeps({ ...base(), db: flaky, mailer }));
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.summary.status).toBe("failed");
    expect(sent).toHaveLength(0);
    const run = await runRow(result.summary.runId);
    expect(run).toMatchObject({ status: "failed", email_status: "skipped" });
    expect(JSON.stringify(run.errors)).toContain("connection terminated");
  });

  it("surfaces a total database outage as an error instead of a silent success", async () => {
    const { mailer, sent } = fakeMailer();
    await expect(runWeeklyDigest(makeDeps({ ...base(), db: failingDb("connection refused"), mailer }))).rejects.toThrow("connection refused");
    expect(sent).toHaveLength(0);
  });

  it("fails clearly when no recipient is configured", async () => {
    await pg.query("update user_preferences set recipient_email = null");
    const { mailer, sent } = fakeMailer();
    const result = await runWeeklyDigest(makeDeps({ ...base(), mailer }));
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.summary).toMatchObject({ status: "failed", emailStatus: "skipped" });
    expect(sent).toHaveLength(0);
  });

  it("does nothing when the weekly digest is switched off", async () => {
    await pg.query("update user_preferences set weekly_enabled = false");
    const { mailer, sent } = fakeMailer();
    expect(await runWeeklyDigest(makeDeps({ ...base(), mailer }))).toMatchObject({ outcome: "skipped", reason: "disabled" });
    expect(sent).toHaveLength(0);
  });
});

describe("manual run and test email", () => {
  it("throttles repeated manual refreshes", async () => {
    const llm = fakeLlm({ extract: () => ({ results: [] }), rank: rankAll([50]) });
    const { mailer, sent } = fakeMailer();
    const deps = makeDeps({ llm: llm.client, mailer });
    const first = await startManualRun(deps);
    expect(first.started).toBe(true);
    if (first.started) {
      const summary = await first.execute();
      expect(summary.emailStatus).toBe("not_applicable"); // a manual refresh never emails
    }
    const second = await startManualRun(deps);
    expect(second).toMatchObject({ started: false });
    expect(sent).toHaveLength(0);
  });

  it("labels test sends clearly and records them separately from the weekly run", async () => {
    const llm = fakeLlm({});
    const { mailer, sent } = fakeMailer();
    const deps = makeDeps({ llm: llm.client, mailer });
    const result = await sendTestEmail(deps);
    expect(result).toMatchObject({ sent: true });
    expect(sent[0].subject.startsWith("[TEST] ")).toBe(true);
    expect(sent[0].html).toContain("TEST SEND");
    const row = (await pg.query<{ trigger_source: string; is_test: boolean }>("select trigger_source, is_test from digest_runs")).rows[0];
    expect(row).toEqual({ trigger_source: "test_email", is_test: true });
    // A second click inside the cooldown is refused and sends nothing.
    expect(await sendTestEmail(deps)).toMatchObject({ sent: false });
    expect(sent).toHaveLength(1);
  });

  it("records a failed test send", async () => {
    const { mailer } = fakeMailer("fail");
    const result = await sendTestEmail(makeDeps({ llm: fakeLlm({}).client, mailer }));
    expect(result).toMatchObject({ sent: false, emailStatus: "failed" });
    expect((await pg.query("select email_status from digest_runs")).rows[0]).toEqual({ email_status: "failed" });
  });
});
