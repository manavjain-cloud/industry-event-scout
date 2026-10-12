import { errorResponse, json, requireAdmin } from "@/lib/auth/guard";
import { createLiveDeps } from "@/lib/pipeline/deps";
import { previewDigest } from "@/lib/pipeline/entrypoints";

/** Render the digest from stored events. Sends nothing and calls no external API. */
export async function POST(request: Request) {
  const denied = await requireAdmin(request, { mutating: true });
  if (denied) return denied;
  try {
    return json({ preview: await previewDigest(createLiveDeps()) });
  } catch (err) {
    return errorResponse(err, "digest.preview");
  }
}
