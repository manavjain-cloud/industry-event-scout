import { LIMITS } from "@/lib/config";
import { loadEventsOverlapping } from "@/lib/db/events";
import { getPreferences } from "@/lib/db/preferences";
import { claimRun, claimThrottledRun, updateRun } from "@/lib/db/runs";
import { computeWindow } from "@/lib/dates/window";
import { errorMessage, log } from "@/lib/log";
import { buildDigest, renderDigest, type Rendered } from "@/lib/output/digest";
import { MailError } from "@/lib/output/mailer";
import type { EmailStatus, RunStatus } from "@/lib/types";
import type { PipelineDeps } from "./deps";
import { executeRun, weeklyRunKey, type RunSummary } from "./run";

export type WeeklyOutcome =
  | { outcome: "completed"; summary: RunSummary }
  | { outcome: "skipped"; reason: "disabled" | "already_sent" | "already_completed" | "in_progress"; runId: string | null };

/**
 * TRIGGER -> weekly digest. Idempotent per ISO week: a duplicate cron delivery or a manual
 * retry can never send a second digest for a week whose email was already delivered.
 */
export async function runWeeklyDigest(deps: PipelineDeps): Promise<WeeklyOutcome> {
  const now = deps.now();
  const prefs = await getPreferences(deps.db);
  if (!prefs.weeklyEnabled) return { outcome: "skipped", reason: "disabled", runId: null };

  const runKey = weeklyRunKey(now, prefs.timezone);
  const claim = await claimRun(deps.db, { runKey, trigger: "cron", emailStatus: "pending" });
  if (!claim.claimed) {
    log("info", "cron.skipped", { runKey, reason: claim.reason });
    return { outcome: "skipped", reason: claim.reason, runId: claim.runId };
  }
  const summary = await executeRun(deps, { runId: claim.runId, runKey, trigger: "cron", sendEmail: true, attempt: claim.attempt });
  return { outcome: "completed", summary };
}

export type ManualStart =
  | { started: true; runId: string; execute: () => Promise<RunSummary> }
  | { started: false; retryAfterSeconds: number; reason: string };

/** Protected user-initiated discovery run (refreshes data; never sends the weekly email). Throttled for cost control. */
export async function startManualRun(deps: PipelineDeps): Promise<ManualStart> {
  const runKey = `manual:${crypto.randomUUID()}`;
  const claim = await claimThrottledRun(deps.db, {
    trigger: "manual",
    cooldownMs: LIMITS.manualRunCooldownMs,
    emailStatus: "not_applicable",
    isTest: false,
    runKey,
  });
  if (!claim.allowed) return { started: false, retryAfterSeconds: claim.retryAfterSeconds, reason: claim.reason };
  return {
    started: true,
    runId: claim.runId,
    execute: () => executeRun(deps, { runId: claim.runId, runKey, trigger: "manual", sendEmail: false, attempt: 1 }),
  };
}

/** Build and render the digest from stored events without sending anything. */
export async function previewDigest(deps: PipelineDeps): Promise<Rendered & { itemCount: number; urgentCount: number; rankingAvailable: boolean }> {
  const now = deps.now();
  const prefs = await getPreferences(deps.db);
  const window = computeWindow(now, prefs.timezone, prefs.windowDays);
  const events = await loadEventsOverlapping(deps.db, window.start, window.end);
  const digest = buildDigest(events, prefs, now);
  return { ...renderDigest(digest, prefs, deps.appUrl), itemCount: digest.items.length, urgentCount: digest.urgent.length, rankingAvailable: digest.rankingAvailable };
}

export type TestEmailResult =
  | { sent: true; runId: string; status: RunStatus; emailStatus: EmailStatus }
  | { sent: false; runId: string | null; emailStatus: EmailStatus | null; error: string; retryAfterSeconds?: number };

/**
 * Explicit, clearly labelled test send ("[TEST]" subject + banner). It uses the stored
 * events (no discovery), is throttled, and is recorded as its own run so it can never be
 * mistaken for - or block - the scheduled weekly digest.
 */
export async function sendTestEmail(deps: PipelineDeps): Promise<TestEmailResult> {
  const runKey = `test:${crypto.randomUUID()}`;
  const claim = await claimThrottledRun(deps.db, {
    trigger: "test_email",
    cooldownMs: LIMITS.testEmailCooldownMs,
    emailStatus: "pending",
    isTest: true,
    runKey,
  });
  if (!claim.allowed) {
    return { sent: false, runId: null, emailStatus: null, error: claim.reason, retryAfterSeconds: claim.retryAfterSeconds };
  }
  const runId = claim.runId;
  try {
    const now = deps.now();
    const prefs = await getPreferences(deps.db);
    if (!prefs.recipientEmail) {
      const error = "No recipient email is configured. Set it in the dashboard settings first.";
      await updateRun(deps.db, runId, { status: "failed", finished: true, emailStatus: "skipped", emailError: error });
      return { sent: false, runId, emailStatus: "skipped", error };
    }
    const window = computeWindow(now, prefs.timezone, prefs.windowDays);
    const events = await loadEventsOverlapping(deps.db, window.start, window.end);
    const digest = buildDigest(events, prefs, now, { isTest: true });
    const rendered = renderDigest(digest, prefs, deps.appUrl);
    await updateRun(deps.db, runId, {
      windowStart: window.start,
      windowEnd: window.end,
      timezone: prefs.timezone,
      digestSubject: rendered.subject,
      digestReadMinutes: rendered.readMinutes,
      retainedCount: digest.items.length,
      urgentCount: digest.urgent.length,
      emailStatus: "sending",
    });
    try {
      const { id } = await deps.mailer.send({
        to: prefs.recipientEmail,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: `test/${runId}`,
      });
      await updateRun(deps.db, runId, { status: "succeeded", finished: true, emailStatus: "sent", emailSent: true, emailProviderId: id, emailError: null });
      return { sent: true, runId, status: "succeeded", emailStatus: "sent" };
    } catch (err) {
      const error = err instanceof MailError ? err.message : `Email delivery failed: ${errorMessage(err)}`;
      await updateRun(deps.db, runId, { status: "failed", finished: true, emailStatus: "failed", emailError: error });
      return { sent: false, runId, emailStatus: "failed", error };
    }
  } catch (err) {
    const error = errorMessage(err);
    try {
      await updateRun(deps.db, runId, { status: "failed", finished: true, emailStatus: "failed", emailError: error });
    } catch {
      /* the database itself is down; the caller still receives the error */
    }
    return { sent: false, runId, emailStatus: "failed", error };
  }
}
