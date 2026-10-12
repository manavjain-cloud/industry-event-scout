import { describe, expect, it } from "vitest";
import { hasEnv } from "@/lib/env";

/**
 * LIVE integration path. Uses real credentials from .env.local and real network calls.
 *   npm run test:live
 * It runs a complete discovery (Tavily -> pages -> Gemini -> Neon) with a stub mailer, so it
 * can never send an email. It does write the discovered live events to DATABASE_URL (the same
 * thing the dashboard's "Refresh events" button does) and spends a handful of API credits.
 */
const ready = hasEnv("DATABASE_URL") && hasEnv("TAVILY_API_KEY") && hasEnv("GEMINI_API_KEY");

describe.skipIf(!ready)("live discovery (real Tavily + Gemini + Neon, no email)", () => {
  it("finds real, source-linked, in-window events and records an honest run", async () => {
    const { createLiveDeps } = await import("@/lib/pipeline/deps");
    const { startManualRun } = await import("@/lib/pipeline/entrypoints");
    const { getRun } = await import("@/lib/db/runs");
    const { loadEventsOverlapping } = await import("@/lib/db/events");
    const { getPreferences } = await import("@/lib/db/preferences");
    const { computeWindow } = await import("@/lib/dates/window");
    const { validateHttpUrl } = await import("@/lib/processing/urls");

    const deps = { ...createLiveDeps(), mailer: { send: async () => { throw new Error("mailer must not be used by a discovery run"); } } };
    // Manual runs are throttled; if a recent one exists this test reports that instead of spending credits.
    const started = await startManualRun(deps);
    if (!started.started) {
      console.warn(`Skipped: ${started.reason} (retry in ${started.retryAfterSeconds}s)`);
      return;
    }
    const summary = await started.execute();
    const run = await getRun(deps.db, summary.runId);

    expect(run).not.toBeNull();
    expect(["succeeded", "partial"]).toContain(summary.status);
    expect(run!.emailStatus).toBe("not_applicable");
    expect(run!.metrics.searchHits ?? 0).toBeGreaterThan(0);

    const prefs = await getPreferences(deps.db);
    const window = computeWindow(new Date(), prefs.timezone, prefs.windowDays);
    const events = await loadEventsOverlapping(deps.db, window.start, window.end);
    console.log(`Discovered ${events.length} in-window events; stages: ${run!.stages.map((s) => `${s.name}=${s.status}`).join(" | ")}`);

    for (const e of events) {
      expect(e.startsOn >= window.start || (e.endsOn ?? e.startsOn) >= window.start).toBe(true);
      expect(e.startsOn <= window.end).toBe(true);
      expect(e.sources.length).toBeGreaterThan(0);
      for (const s of e.sources) expect(validateHttpUrl(s.url)).not.toBeNull();
      if (e.relevanceScore !== null) {
        expect(Number.isInteger(e.relevanceScore)).toBe(true);
        expect(e.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(e.relevanceScore).toBeLessThanOrEqual(100);
      }
    }
  });
});
