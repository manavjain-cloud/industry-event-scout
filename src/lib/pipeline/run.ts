import { extractFromPages } from "@/lib/ai/extract";
import { rankEvents, type RankInput } from "@/lib/ai/rank";
import { LIMITS } from "@/lib/config";
import { loadEventsOverlapping, loadRecentSourceUrls, upsertEvents } from "@/lib/db/events";
import { getPreferences } from "@/lib/db/preferences";
import { saveRunEvents, updateRun, type RunPatch } from "@/lib/db/runs";
import type { Db } from "@/lib/db/types";
import { classifyAgainstWindow, computeWindow, type EventWindow } from "@/lib/dates/window";
import { DateTime } from "luxon";
import { buildSearchQueries } from "@/lib/input/queries";
import { dedupeHits } from "@/lib/input/tavily";
import { errorMessage, log } from "@/lib/log";
import { buildDigest, renderDigest, type Digest } from "@/lib/output/digest";
import { idempotencyKeyFor, MailError } from "@/lib/output/mailer";
import { buildCandidates, emptyStats } from "@/lib/processing/candidates";
import { dedupeEvents } from "@/lib/processing/dedupe";
import { applyDeterministicFilters } from "@/lib/processing/filters";
import { hashPreferences } from "@/lib/processing/normalize";
import type {
  EmailStatus,
  EventRecord,
  Preferences,
  RunErrorEntry,
  RunMetrics,
  RunStatus,
  RunTrigger,
  StageResult,
} from "@/lib/types";
import type { PipelineDeps } from "./deps";
import { retrievePages } from "./retrieval";

export interface RunRequest {
  runId: string;
  runKey: string;
  trigger: Exclude<RunTrigger, "test_email">;
  /** Weekly cron runs send the digest; manual discovery runs only refresh the data. */
  sendEmail: boolean;
  attempt: number;
}

export interface RunSummary {
  runId: string;
  status: RunStatus;
  emailStatus: EmailStatus;
  retained: number;
  urgent: number;
  errors: RunErrorEntry[];
}

export function emptyMetrics(): RunMetrics {
  return {
    queriesPlanned: 0,
    queriesSucceeded: 0,
    queriesFailed: 0,
    searchHits: 0,
    uniqueUrls: 0,
    pagesEvaluated: 0,
    pagesFetchedDirect: 0,
    pagesViaTavily: 0,
    extractedEvents: 0,
    duplicatesRemoved: 0,
    outsideWindow: 0,
    onlineExcluded: 0,
    eventsInWindow: 0,
    eventsScored: 0,
    eventsUnscored: 0,
    retained: 0,
    urgent: 0,
    eventsWithEvidenceDates: 0,
    geminiCalls: 0,
    tavilyCredits: 0,
  };
}

type Category = StageResult["category"];

/** Records each stage's outcome and mirrors progress into Neon so the dashboard can show it live. */
class Recorder {
  readonly stages: StageResult[] = [];
  readonly errors: RunErrorEntry[] = [];
  constructor(
    private readonly db: Db,
    private readonly runId: string,
  ) {}

  async flush(extra: RunPatch = {}): Promise<void> {
    try {
      await updateRun(this.db, this.runId, { stages: this.stages, errors: this.errors, ...extra });
    } catch (err) {
      log("error", "run.progress_write_failed", { runId: this.runId, error: errorMessage(err) });
    }
  }

  /**
   * Run one stage. `fn` may call `ctx.partial(detail)` to flag degraded output.
   * A thrown error marks the stage failed (message stored) and yields `undefined`.
   */
  async stage<T>(
    name: string,
    category: Category,
    fn: (ctx: { partial: (detail: string) => void; detail: (text: string) => void }) => Promise<T> | T,
  ): Promise<T | undefined> {
    const t0 = Date.now();
    let status: StageResult["status"] = "ok";
    let detail: string | undefined;
    let error: string | undefined;
    let value: T | undefined;
    try {
      value = await fn({
        partial: (d) => {
          status = "partial";
          detail = detail ? `${detail}; ${d}` : d;
        },
        detail: (d) => {
          detail = detail ? `${detail}; ${d}` : d;
        },
      });
    } catch (err) {
      status = "failed";
      error = errorMessage(err);
      this.errors.push({ stage: name, message: error });
      log("error", "run.stage_failed", { runId: this.runId, stage: name, error });
    }
    this.stages.push({ name, category, status, durationMs: Date.now() - t0, ...(detail ? { detail } : {}), ...(error ? { error } : {}) });
    await this.flush();
    return value;
  }

  add(result: StageResult): void {
    this.stages.push(result);
  }
}

function needsScore(e: EventRecord, prefsHash: string, now: Date): boolean {
  if (e.relevanceScore === null || e.scoredForHash !== prefsHash || !e.scoredAt) return true;
  return now.getTime() - Date.parse(e.scoredAt) > LIMITS.rescoreAfterDays * 86_400_000;
}

/** Weekly key: one digest per ISO week in the user's timezone. */
export function weeklyRunKey(now: Date, tz: string): string {
  const dt = DateTime.fromJSDate(now).setZone(tz);
  return `weekly:${dt.weekYear}-W${String(dt.weekNumber).padStart(2, "0")}`;
}

export async function executeRun(deps: PipelineDeps, req: RunRequest): Promise<RunSummary> {
  const { db } = deps;
  const rec = new Recorder(db, req.runId);
  const metrics = emptyMetrics();
  const deadline = Date.now() + LIMITS.runBudgetMs;
  const now = deps.now();
  let emailStatus: EmailStatus = req.sendEmail ? "pending" : "not_applicable";
  let persistFailed = false;
  let retained = 0;
  let urgent = 0;

  rec.add({ name: `${req.trigger} trigger`, category: "TRIGGER", status: "ok", durationMs: 0, detail: `run ${req.runKey}, attempt ${req.attempt}` });

  const finish = async (status: RunStatus): Promise<RunSummary> => {
    const unsent = req.sendEmail && emailStatus === "pending";
    if (unsent) emailStatus = "skipped";
    await rec.flush({
      status,
      finished: true,
      metrics,
      retainedCount: retained,
      urgentCount: urgent,
      ...(unsent ? { emailStatus: "skipped" as const, emailError: "Not sent: the run failed before the email stage." } : {}),
    });
    log(status === "failed" ? "error" : "info", "run.finished", { runId: req.runId, status, emailStatus, retained });
    return { runId: req.runId, status, emailStatus, retained, urgent, errors: rec.errors };
  };

  try {
    // ---------------------------------------------------------------- CONTEXT
    const ctx = await rec.stage("load preferences and stored events", "CONTEXT", async (c) => {
      const prefs = await getPreferences(db);
      const window = computeWindow(now, prefs.timezone, prefs.windowDays);
      const sinceIso = new Date(now.getTime() - LIMITS.reuseSourceDays * 86_400_000).toISOString();
      const [stored, recentUrls] = await Promise.all([loadEventsOverlapping(db, window.start, window.end), loadRecentSourceUrls(db, sinceIso)]);
      c.detail(`window ${window.start} to ${window.end} (${prefs.timezone}); ${stored.length} stored events`);
      return { prefs, window, stored, recentUrls };
    });
    if (!ctx) return await finish("failed");
    const { prefs, window, stored, recentUrls } = ctx;
    await rec.flush({ windowStart: window.start, windowEnd: window.end, timezone: prefs.timezone });
    const prefsHash = hashPreferences(prefs.focusAreas, prefs.cities);

    // ------------------------------------------------------------------ INPUT
    const weekNumber = DateTime.fromJSDate(now).setZone(prefs.timezone).weekNumber;
    const queries = buildSearchQueries(prefs, window, weekNumber);
    metrics.queriesPlanned = queries.length;

    const search = await rec.stage("search (Tavily)", "INPUT", async (c) => {
      if (queries.length === 0) throw new Error("No search queries could be built: add at least one focus area and one city.");
      const res = await deps.search(queries, deadline);
      metrics.queriesSucceeded = res.succeeded;
      metrics.queriesFailed = res.failures.length;
      metrics.searchHits = res.hits.length;
      metrics.tavilyCredits = res.credits;
      if (res.succeeded === 0) {
        throw new Error(`All ${queries.length} searches failed: ${res.failures[0]?.message ?? "unknown error"}`);
      }
      if (res.failures.length > 0) {
        c.partial(`${res.failures.length} of ${queries.length} searches failed (${[...new Set(res.failures.map((f) => f.kind))].join(", ")})`);
        for (const f of res.failures.slice(0, 5)) rec.errors.push({ stage: "search (Tavily)", message: `${f.queryId}: ${f.message}` });
      }
      c.detail(`${res.succeeded}/${queries.length} searches ok, ${res.hits.length} hits, ${res.credits} credits`);
      return res;
    });
    const searchFailed = !search;

    const uniqueHits = dedupeHits(search?.hits ?? []);
    metrics.uniqueUrls = uniqueHits.length;
    const fresh = uniqueHits.filter((h) => !recentUrls.has(h.normalizedUrl)).slice(0, LIMITS.maxPagesPerRun);

    const retrieval = await rec.stage("retrieve public event pages", "INPUT", async (c) => {
      const out = await retrievePages(fresh, deps, { deadline });
      metrics.pagesEvaluated = out.pages.length;
      metrics.pagesFetchedDirect = out.stats.direct;
      metrics.pagesViaTavily = out.stats.viaTavily;
      const failures = Object.entries(out.stats.directFailures).map(([k, v]) => `${k}:${v}`).join(", ");
      c.detail(
        `${out.pages.length} pages kept of ${fresh.length} new URLs (${uniqueHits.length - fresh.length} already known); direct ${out.stats.direct}, via Tavily ${out.stats.viaTavily}` +
          (out.stats.skippedNoDateSignal ? `; ${out.stats.skippedNoDateSignal} without date text` : "") +
          (failures ? `; direct-fetch skips ${failures}` : ""),
      );
      return out;
    });
    const pages = retrieval?.pages ?? [];

    // ------------------------------------------------- AI (extraction) + PROCESSING
    const extraction = await rec.stage("extract event facts (Gemini)", "AI", async (c) => {
      if (pages.length === 0) {
        c.detail("no new pages to extract");
        return { items: new Map(), missing: [], calls: 0, errors: [] as string[] };
      }
      const out = await extractFromPages(deps.llm, pages, { today: window.start, timezone: prefs.timezone, deadline });
      metrics.geminiCalls += out.calls;
      if (out.errors.length > 0 && out.items.size === 0) throw new Error(out.errors[0]);
      if (out.errors.length > 0 || out.missing.length > 0) {
        c.partial(`${out.missing.length} page(s) without a valid extraction`);
        for (const e of out.errors.slice(0, 3)) rec.errors.push({ stage: "extract event facts (Gemini)", message: e });
      }
      c.detail(`${out.items.size} pages extracted in ${out.calls} call(s)`);
      return out;
    });

    const candidates = await rec.stage("normalize and validate candidates", "PROCESSING", (c) => {
      const stats = emptyStats();
      const built = buildCandidates(pages, extraction?.items ?? new Map(), now.toISOString(), stats);
      metrics.extractedEvents = built.length;
      c.detail(
        `${built.length} candidates (${stats.fromJsonLd} from schema.org markup, ${stats.fromEvidence} from evidence-checked AI extraction); ` +
          `dropped: ${stats.rejectedDates} unverifiable dates, ${stats.pagesWithoutEvent} non-event pages; ${stats.rejectedDeadlines} deadlines and ${stats.rejectedVenueOrCity} venue/city values left unknown`,
      );
      return built;
    });

    const merged = await rec.stage("deduplicate and apply filters", "PROCESSING", (c) => {
      const { events, duplicatesRemoved } = dedupeEvents([...stored, ...(candidates ?? [])]);
      metrics.duplicatesRemoved = duplicatesRemoved;
      const inWindow = events.filter((e) => classifyAgainstWindow(e, window) === "in_window");
      metrics.outsideWindow = events.length - inWindow.length;
      const { kept, counts } = applyDeterministicFilters(inWindow, window, prefs);
      metrics.onlineExcluded = counts.online;
      metrics.eventsInWindow = kept.length;
      c.detail(
        `${duplicatesRemoved} duplicates merged; ${metrics.outsideWindow} outside the ${prefs.windowDays}-day window; ` +
          `${counts.online} online-only and ${counts.outsideTargetCities} outside target cities excluded; ${kept.length} eligible`,
      );
      return { all: inWindow, kept };
    });

    // ------------------------------------------------------------------- AI (ranking)
    let all: EventRecord[] = merged?.all ?? [];
    const kept = merged?.kept ?? [];
    const toScore = kept.filter((e) => needsScore(e, prefsHash, now));
    await rec.stage("rank relevance (Gemini)", "AI", async (c) => {
      if (toScore.length === 0) {
        c.detail(kept.length ? "all eligible events already scored for the current preferences" : "no eligible events to rank");
        return;
      }
      const inputs: RankInput[] = toScore.map((event, i) => ({ id: `e${i + 1}`, event }));
      const out = await rankEvents(deps.llm, inputs, prefs, { deadline });
      metrics.geminiCalls += out.calls;
      const byKey = new Map(inputs.map((i) => [i.id, i.event.dedupeKey]));
      const scored = new Map<string, EventRecord>();
      for (const [id, s] of out.scores) {
        const key = byKey.get(id)!;
        const base = toScore.find((e) => e.dedupeKey === key)!;
        scored.set(key, {
          ...base,
          relevanceScore: s.relevanceScore,
          relevanceReason: s.relevanceReason,
          summary: s.summary,
          matchedFocusAreas: s.matchedFocusAreas,
          scoredForHash: prefsHash,
          scoredAt: now.toISOString(),
        });
      }
      all = all.map((e) => scored.get(e.dedupeKey) ?? e);
      metrics.eventsScored = scored.size;
      metrics.eventsUnscored = out.unscored.length;
      for (const e of out.errors.slice(0, 3)) rec.errors.push({ stage: "rank relevance (Gemini)", message: e });
      if (out.providerFailed && scored.size === 0) throw new Error(out.errors[0] ?? "Gemini was unavailable; no events could be ranked.");
      if (out.unscored.length > 0 || out.invalidItems > 0) {
        c.partial(`${out.unscored.length} event(s) left unranked, ${out.invalidItems} invalid AI item(s) discarded`);
      }
      c.detail(`${scored.size}/${toScore.length} events scored in ${out.calls} call(s)`);
    });

    // ------------------------------------------------------------------------ OUTPUT
    const persisted = await rec.stage("persist events and digest", "OUTPUT", async (c) => {
      const ids = await upsertEvents(db, all);
      all = all.map((e) => ({ ...e, id: ids.get(e.dedupeKey) ?? e.id }));
      const built = buildDigest(all, prefs, now, {
        notes: searchFailed ? ["Live search failed this week, so this digest shows events collected earlier. Their deadlines were re-evaluated today."] : [],
      });
      retained = built.items.length;
      urgent = built.urgent.length;
      metrics.retained = retained;
      metrics.urgent = urgent;
      metrics.eventsWithEvidenceDates = built.items.filter((i) => i.event.dateBasis === "source_evidence").length;
      await saveRunEvents(
        db,
        req.runId,
        built.items
          .filter((i) => i.event.id)
          .map((i) => ({ eventId: i.event.id!, rank: i.rank, relevanceScore: i.event.relevanceScore, deadlineStatus: i.deadline.status, daysRemaining: i.deadline.daysRemaining })),
      );
      c.detail(`${all.length} events stored; ${retained} in digest (${urgent} urgent)`);
      return { digest: built };
    });
    persistFailed = !persisted;
    const digest = persisted?.digest;
    await rec.flush({ candidatesCount: metrics.extractedEvents, retainedCount: retained, urgentCount: urgent, metrics });

    if (req.sendEmail) {
      if (persistFailed || !digest) {
        emailStatus = "skipped";
        rec.errors.push({ stage: "send digest (Resend)", message: "Email not sent: results could not be saved, so delivery could not be recorded safely." });
        rec.add({ name: "send digest (Resend)", category: "OUTPUT", status: "skipped", durationMs: 0, detail: "database persistence failed" });
        await rec.flush({ emailStatus, emailError: "Not sent: database persistence failed." });
      } else {
        emailStatus = await sendDigestEmail(deps, rec, req, prefs, digest);
      }
    }

    const hasProblem = rec.stages.some((s) => s.status === "failed" || s.status === "partial");
    if (persistFailed) return await finish("failed");
    if (req.sendEmail && emailStatus !== "sent") return await finish("failed");
    if (!req.sendEmail && searchFailed && retained === 0) return await finish("failed");
    return await finish(hasProblem ? "partial" : "succeeded");
  } catch (err) {
    rec.errors.push({ stage: "pipeline", message: errorMessage(err) });
    log("error", "run.unexpected", { runId: req.runId, error: errorMessage(err) });
    return await finish("failed");
  }
}

/** Sends the weekly digest and records exactly what happened; "sent" is only ever set after Resend confirms. */
async function sendDigestEmail(
  deps: PipelineDeps,
  rec: Recorder,
  req: RunRequest,
  prefs: Preferences,
  digest: Digest,
): Promise<EmailStatus> {
  const t0 = Date.now();
  const rendered = renderDigest(digest, prefs, deps.appUrl);
  const base: RunPatch = { digestSubject: rendered.subject, digestReadMinutes: rendered.readMinutes };

  if (!prefs.recipientEmail) {
    const message = "No recipient email is configured. Set it in the dashboard settings.";
    rec.errors.push({ stage: "send digest (Resend)", message });
    rec.add({ name: "send digest (Resend)", category: "OUTPUT", status: "failed", durationMs: 0, error: message });
    await rec.flush({ ...base, emailStatus: "skipped", emailError: message });
    return "skipped";
  }

  try {
    await updateRun(deps.db, req.runId, { ...base, emailStatus: "sending" });
    const { id } = await deps.mailer.send({
      to: prefs.recipientEmail,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      idempotencyKey: idempotencyKeyFor(req.runKey, rendered.subject, rendered.html),
    });
    rec.add({ name: "send digest (Resend)", category: "OUTPUT", status: "ok", durationMs: Date.now() - t0, detail: `accepted by Resend (${id})` });
    // Recording "sent" is what blocks a duplicate send on retry, so retry this write before giving up.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await updateRun(deps.db, req.runId, { ...base, emailStatus: "sent", emailSent: true, emailProviderId: id, emailError: null, stages: rec.stages, errors: rec.errors });
        break;
      } catch (writeErr) {
        log("error", "run.sent_status_write_failed", { runId: req.runId, attempt, error: errorMessage(writeErr) });
        if (attempt === 3) rec.errors.push({ stage: "send digest (Resend)", message: "Email was sent but its status could not be recorded; do not retry manually." });
      }
    }
    return "sent";
  } catch (err) {
    const message = err instanceof MailError ? err.message : `Email delivery failed: ${errorMessage(err)}`;
    rec.errors.push({ stage: "send digest (Resend)", message });
    rec.add({ name: "send digest (Resend)", category: "OUTPUT", status: "failed", durationMs: Date.now() - t0, error: message });
    await rec.flush({ ...base, emailStatus: "failed", emailError: message });
    return "failed";
  }
}

export type { EventWindow };
