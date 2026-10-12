import { after } from "next/server";
import { errorResponse, json, requireAdmin } from "@/lib/auth/guard";
import { getDb } from "@/lib/db/client";
import { listRecentRuns, updateRun } from "@/lib/db/runs";
import { errorMessage, log } from "@/lib/log";
import { createLiveDeps } from "@/lib/pipeline/deps";
import { startManualRun } from "@/lib/pipeline/entrypoints";

// A full discovery run uses most of the Hobby-plan 300 s function limit.
export const maxDuration = 300;

export async function GET(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return json({ runs: await listRecentRuns(getDb(), 20) });
  } catch (err) {
    return errorResponse(err, "runs.list");
  }
}

/** Start a controlled manual discovery run. Returns immediately; the run continues after the response. */
export async function POST(request: Request) {
  const denied = await requireAdmin(request, { mutating: true });
  if (denied) return denied;
  try {
    const deps = createLiveDeps();
    const started = await startManualRun(deps);
    if (!started.started) {
      return json({ error: started.reason, retryAfterSeconds: started.retryAfterSeconds }, 429, {
        "Retry-After": String(started.retryAfterSeconds),
      });
    }
    after(async () => {
      try {
        await started.execute();
      } catch (err) {
        log("error", "manual_run.unexpected", { runId: started.runId, error: errorMessage(err) });
        try {
          await updateRun(deps.db, started.runId, {
            status: "failed",
            finished: true,
            errors: [{ stage: "pipeline", message: errorMessage(err) }],
          });
        } catch {
          /* database unavailable: nothing more can be recorded */
        }
      }
    });
    return json({ runId: started.runId }, 202);
  } catch (err) {
    return errorResponse(err, "runs.start");
  }
}
