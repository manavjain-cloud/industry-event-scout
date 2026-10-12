import { NextResponse } from "next/server";
import { errorResponse, isSameOrigin, json } from "@/lib/auth/guard";
import { SESSION_COOKIE, createSessionToken, passwordMatches, sessionCookieOptions } from "@/lib/auth/session";
import { clientFingerprint, isLoginBlocked, recordLoginAttempt } from "@/lib/auth/throttle";
import { getDb } from "@/lib/db/client";
import { hasEnv } from "@/lib/env";
import { loginInputSchema } from "@/lib/schemas";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin request refused" }, 403);
  try {
    const body = loginInputSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return json({ error: "Enter the dashboard password." }, 400);

    // Throttling lives in Neon. If the database is not configured yet nothing is exposed
    // (the dashboard only shows a setup checklist), so login still works for first-time setup.
    const dbConfigured = hasEnv("DATABASE_URL");
    const fingerprint = clientFingerprint(request);
    if (dbConfigured && (await isLoginBlocked(getDb(), fingerprint))) {
      return json({ error: "Too many failed attempts. Try again in about 10 minutes." }, 429, { "Retry-After": "600" });
    }

    const ok = passwordMatches(body.data.password);
    if (dbConfigured) await recordLoginAttempt(getDb(), fingerprint, ok);
    if (!ok) return json({ error: "Incorrect password." }, 401);

    const token = await createSessionToken();
    const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(process.env.NODE_ENV === "production"));
    return res;
  } catch (err) {
    return errorResponse(err, "auth.login");
  }
}
