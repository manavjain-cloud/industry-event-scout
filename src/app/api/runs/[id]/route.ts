import { errorResponse, json, requireAdmin } from "@/lib/auth/guard";
import { getDb } from "@/lib/db/client";
import { getRun } from "@/lib/db/runs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return json({ error: "Invalid run id" }, 400);
  try {
    const run = await getRun(getDb(), id);
    return run ? json({ run }) : json({ error: "Run not found" }, 404);
  } catch (err) {
    return errorResponse(err, "runs.get");
  }
}
