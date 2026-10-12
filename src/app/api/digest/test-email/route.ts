import { errorResponse, json, requireAdmin } from "@/lib/auth/guard";
import { createLiveDeps } from "@/lib/pipeline/deps";
import { sendTestEmail } from "@/lib/pipeline/entrypoints";

/** Explicit, throttled test send. Clearly labelled "[TEST]" and recorded as its own run. */
export async function POST(request: Request) {
  const denied = await requireAdmin(request, { mutating: true });
  if (denied) return denied;
  try {
    const result = await sendTestEmail(createLiveDeps());
    if (result.sent) return json({ ok: true, runId: result.runId });
    const status = result.retryAfterSeconds ? 429 : 502;
    return json({ ok: false, error: result.error, runId: result.runId, retryAfterSeconds: result.retryAfterSeconds }, status, result.retryAfterSeconds ? { "Retry-After": String(result.retryAfterSeconds) } : {});
  } catch (err) {
    return errorResponse(err, "digest.test_email");
  }
}
