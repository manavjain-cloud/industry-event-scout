import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/lib/db/types";
import { getPreferences, savePreferences } from "@/lib/db/preferences";
import { loadEventsOverlapping, upsertEvents, loadRecentSourceUrls } from "@/lib/db/events";
import { claimRun, claimThrottledRun, getRun, listRecentRuns, saveRunEvents, updateRun } from "@/lib/db/runs";
import { preferencesInputSchema } from "@/lib/schemas";
import { makeEvent, makeSource } from "./helpers";
import { createTestDb } from "./pgdb";

let db: Db;
let pg: PGlite;
beforeAll(async () => ({ db, pg } = await createTestDb()));
afterAll(async () => pg.close());

describe("preferences (context stored in Neon, editable without code)", () => {
  it("creates editable defaults on first read, then persists updates", async () => {
    const first = await getPreferences(db);
    expect(first.timezone).toBe("Asia/Kolkata");
    expect(first.recipientEmail).toBeNull();
    expect(first.focusAreas.length).toBeGreaterThan(0);

    const input = preferencesInputSchema.parse({
      recipientEmail: "vikram@example.com",
      timezone: "Asia/Kolkata",
      focusAreas: ["Supply chain", "supply chain", "Fintech"],
      cities: ["Pune"],
      windowDays: 30,
      maxDigestEvents: 10,
      weeklyEnabled: true,
    });
    const saved = await savePreferences(db, input);
    expect(saved.focusAreas).toEqual(["Supply chain", "Fintech"]); // case-insensitive de-dup
    expect((await getPreferences(db)).cities).toEqual(["Pune"]);
  });

  it("rejects invalid settings before they reach the database", () => {
    const base = { recipientEmail: "a@b.co", timezone: "Asia/Kolkata", focusAreas: ["x1"], cities: ["Pune"], windowDays: 30, maxDigestEvents: 10, weeklyEnabled: true };
    expect(preferencesInputSchema.safeParse({ ...base, recipientEmail: "not-an-email" }).success).toBe(false);
    expect(preferencesInputSchema.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
    expect(preferencesInputSchema.safeParse({ ...base, focusAreas: [] }).success).toBe(false);
    expect(preferencesInputSchema.safeParse({ ...base, windowDays: 400 }).success).toBe(false);
    expect(preferencesInputSchema.safeParse({ ...base, cities: ["<script>"] }).success).toBe(false);
    expect(preferencesInputSchema.safeParse({ ...base, recipientEmail: "" }).data?.recipientEmail).toBeNull();
  });
});

describe("events persistence", () => {
  it("upserts events + sources in batch and is idempotent on re-run", async () => {
    const a = makeEvent({ title: "Persist Alpha", registrationDeadline: null, sources: [makeSource("https://p.example.com/a")] });
    const b = makeEvent({ title: "Persist Beta", registrationDeadline: "2026-10-20", sources: [makeSource("https://p.example.com/b"), makeSource("https://q.example.com/b")] });

    const ids1 = await upsertEvents(db, [a, b]);
    const ids2 = await upsertEvents(db, [a, b]);
    expect(ids1.size).toBe(2);
    expect(ids2.get(a.dedupeKey)).toBe(ids1.get(a.dedupeKey));

    const stored = await loadEventsOverlapping(db, "2026-10-12", "2026-11-11");
    const beta = stored.find((e) => e.title === "Persist Beta");
    expect(beta?.sources).toHaveLength(2);
    expect(beta?.registrationDeadline).toBe("2026-10-20");
    expect(stored.find((e) => e.title === "Persist Alpha")?.registrationDeadline).toBeNull(); // unknown stays NULL
    const count = await pg.query<{ n: number }>("select count(*)::int as n from events where title like 'Persist %'");
    expect(count.rows[0].n).toBe(2);
    expect((await loadRecentSourceUrls(db, "2020-01-01T00:00:00Z")).has("https://p.example.com/a")).toBe(true);
  });

  it("keeps an existing score when a re-run could not score (AI failure)", async () => {
    const scored = makeEvent({ title: "Keep Score", relevanceScore: 77, relevanceReason: "good", scoredForHash: "h1", scoredAt: "2026-10-12T00:00:00Z", sources: [makeSource("https://k.example.com/1")] });
    await upsertEvents(db, [scored]);
    await upsertEvents(db, [{ ...scored, relevanceScore: null, relevanceReason: null, scoredForHash: null, scoredAt: null }]);
    const stored = (await loadEventsOverlapping(db, "2026-10-12", "2026-11-11")).find((e) => e.title === "Keep Score");
    expect(stored?.relevanceScore).toBe(77);
    expect(stored?.scoredForHash).toBe("h1");
  });

  it("enforces constraints at the database level", async () => {
    await expect(pg.query("insert into events (dedupe_key,title,starts_on,date_basis,relevance_score) values ('k1','t','2026-10-20','json_ld',101)")).rejects.toThrow();
    await expect(pg.query("insert into events (dedupe_key,title,starts_on,ends_on,date_basis) values ('k2','t','2026-10-20','2026-10-10','json_ld')")).rejects.toThrow();
    await expect(pg.query("insert into events (dedupe_key,title,starts_on,date_basis) values ('k3','t','2026-10-20','guess')")).rejects.toThrow();
  });
});

describe("run claiming - duplicate-run / duplicate-send protection", () => {
  it("grants the first claim and refuses a concurrent duplicate", async () => {
    const first = await claimRun(db, { runKey: "weekly:2026-W42", trigger: "cron", emailStatus: "pending" });
    expect(first).toMatchObject({ claimed: true, attempt: 1 });
    const dup = await claimRun(db, { runKey: "weekly:2026-W42", trigger: "cron", emailStatus: "pending" });
    expect(dup).toMatchObject({ claimed: false, reason: "in_progress" });
  });

  it("never re-sends a week whose email was already sent, even if the run later looks failed", async () => {
    const key = "weekly:2026-W43";
    const c = await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" });
    if (!c.claimed) throw new Error("expected claim");
    await updateRun(db, c.runId, { status: "partial", finished: true, emailStatus: "sent", emailSent: true, emailProviderId: "re_123" });
    expect(await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" })).toMatchObject({ claimed: false, reason: "already_sent" });
  });

  it("lets a failed run (email not sent) be retried and bumps the attempt", async () => {
    const key = "weekly:2026-W44";
    const c = await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" });
    if (!c.claimed) throw new Error("expected claim");
    await updateRun(db, c.runId, { status: "failed", finished: true, emailStatus: "failed", emailError: "resend 500" });
    const retry = await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" });
    expect(retry).toMatchObject({ claimed: true, attempt: 2, runId: c.runId });
    const row = await getRun(db, c.runId);
    expect(row).toMatchObject({ status: "running", emailStatus: "pending", emailError: null });
  });

  it("refuses to re-run a succeeded week", async () => {
    const key = "weekly:2026-W45";
    const c = await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" });
    if (!c.claimed) throw new Error("expected claim");
    await updateRun(db, c.runId, { status: "succeeded", finished: true, emailStatus: "skipped" });
    expect(await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" })).toMatchObject({ claimed: false, reason: "already_completed" });
  });

  it("takes over a stale 'running' run whose process died", async () => {
    const key = "weekly:2026-W46";
    const c = await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" });
    if (!c.claimed) throw new Error("expected claim");
    await pg.query("update digest_runs set started_at = now() - interval '30 minutes' where id = $1", [c.runId]);
    expect(await claimRun(db, { runKey: key, trigger: "cron", emailStatus: "pending" })).toMatchObject({ claimed: true, attempt: 2 });
  });

  it("only one of two simultaneous claims wins", async () => {
    const results = await Promise.all([1, 2, 3].map(() => claimRun(db, { runKey: "weekly:2026-W47", trigger: "cron", emailStatus: "pending" })));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });
});

describe("manual run throttling (cost control)", () => {
  it("allows one manual run, then blocks repeated clicks", async () => {
    // Clear the in-flight cron runs left by earlier tests so only the manual path is measured.
    await pg.query("update digest_runs set status = 'failed', finished_at = now() where status = 'running'");
    const opts = { trigger: "manual" as const, cooldownMs: 5 * 60_000, emailStatus: "not_applicable" as const, isTest: false };
    const first = await claimThrottledRun(db, { ...opts, runKey: `manual:${crypto.randomUUID()}` });
    expect(first.allowed).toBe(true);
    const second = await claimThrottledRun(db, { ...opts, runKey: `manual:${crypto.randomUUID()}` });
    expect(second).toMatchObject({ allowed: false });
    if (!second.allowed) {
      expect(second.retryAfterSeconds).toBeGreaterThan(0);
      expect(second.reason).toMatch(/in progress/i);
    }
  });
});

describe("run events + history", () => {
  it("stores the ordered event list and lists recent runs", async () => {
    const c = await claimRun(db, { runKey: "weekly:2026-W50", trigger: "cron", emailStatus: "pending" });
    if (!c.claimed) throw new Error("expected claim");
    const ids = await upsertEvents(db, [makeEvent({ title: "Run Event 1", sources: [makeSource("https://r.example.com/1")] }), makeEvent({ title: "Run Event 2", sources: [makeSource("https://r.example.com/2")] })]);
    const [id1, id2] = [...ids.values()];
    await saveRunEvents(db, c.runId, [
      { eventId: id1, rank: 1, relevanceScore: 90, deadlineStatus: "urgent", daysRemaining: 3 },
      { eventId: id2, rank: 2, relevanceScore: 70, deadlineStatus: "unknown", daysRemaining: null },
    ]);
    await saveRunEvents(db, c.runId, [{ eventId: id2, rank: 1, relevanceScore: 70, deadlineStatus: "unknown", daysRemaining: null }]); // idempotent replace
    const n = await pg.query<{ n: number }>("select count(*)::int as n from digest_run_events where run_id = $1", [c.runId]);
    expect(n.rows[0].n).toBe(1);

    await updateRun(db, c.runId, { status: "succeeded", finished: true, stages: [{ name: "x", category: "INPUT", status: "ok", durationMs: 5 }], metrics: { retained: 1 }, retainedCount: 1 });
    const runs = await listRecentRuns(db, 50);
    const mine = runs.find((r) => r.id === c.runId);
    expect(mine?.stages[0].name).toBe("x");
    expect(mine?.metrics.retained).toBe(1);
  });
});
