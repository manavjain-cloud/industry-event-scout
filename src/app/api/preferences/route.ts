import { errorResponse, json, requireAdmin } from "@/lib/auth/guard";
import { getDb } from "@/lib/db/client";
import { getPreferences, savePreferences } from "@/lib/db/preferences";
import { preferencesInputSchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  try {
    return json({ preferences: await getPreferences(getDb()) });
  } catch (err) {
    return errorResponse(err, "preferences.get");
  }
}

export async function PUT(request: Request) {
  const denied = await requireAdmin(request, { mutating: true });
  if (denied) return denied;
  try {
    const parsed = preferencesInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json({ error: "Some settings are invalid.", issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) }, 400);
    }
    return json({ preferences: await savePreferences(getDb(), parsed.data) });
  } catch (err) {
    return errorResponse(err, "preferences.put");
  }
}
