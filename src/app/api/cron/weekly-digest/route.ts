import { errorResponse, isValidCronRequest, json } from "@/lib/auth/guard";
import { createLiveDeps } from "@/lib/pipeline/deps";
import { runWeeklyDigest } from "@/lib/pipeline/entrypoints";

// Hobby functions are capped at 300 s; the pipeline keeps its own time budget below that.
export const maxDuration = 300;

/**
 * TRIGGER: Vercel Cron (Mondays 02:30 UTC, see vercel.json) calls this with
 * `Authorization: Bearer $CRON_SECRET`. Anything else is rejected before any work or spend.
 * Vercel does not retry failures, so a failed run answers 500 (visible in cron logs) and
 * can be retried safely: delivery is idempotent per ISO week.
 */
export async function GET(request: Request) {
  if (!isValidCronRequest(request)) return json({ error: "Unauthorized" }, 401);
  try {
    const result = await runWeeklyDigest(createLiveDeps());
    if (result.outcome === "skipped") return json({ ok: true, skipped: result.reason, runId: result.runId });
    const { summary } = result;
    const body = { ok: summary.status !== "failed", runId: summary.runId, status: summary.status, emailStatus: summary.emailStatus, retained: summary.retained, urgent: summary.urgent };
    return json(body, summary.status === "failed" ? 500 : 200);
  } catch (err) {
    return errorResponse(err, "cron.weekly_digest");
  }
}
