import { createHash, timingSafeEqual } from "node:crypto";
import { MissingEnvError, env } from "@/lib/env";
import { errorMessage, log } from "@/lib/log";
import { cookieFromHeader, SESSION_COOKIE, verifySessionToken } from "./session";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Is this request carrying a valid dashboard session cookie? */
export async function hasAdminSession(request: Request): Promise<boolean> {
  try {
    return await verifySessionToken(cookieFromHeader(request.headers.get("cookie"), SESSION_COOKIE));
  } catch {
    return false; // AUTH_SECRET missing/invalid => nobody is authenticated
  }
}

/**
 * Reject cross-site state-changing requests. The session cookie is SameSite=Strict
 * already; this is defence in depth for browsers that mishandle it.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser clients (curl/cron) carry no Origin
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Returns an error Response when the caller is not an authenticated admin, otherwise null. */
export async function requireAdmin(request: Request, opts: { mutating?: boolean } = {}): Promise<Response | null> {
  if (!(await hasAdminSession(request))) return json({ error: "Unauthorized" }, 401);
  if (opts.mutating && !isSameOrigin(request)) return json({ error: "Cross-origin request refused" }, 403);
  return null;
}

/** Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`; compared in constant time. */
export function isValidCronRequest(request: Request): boolean {
  let secret: string;
  try {
    secret = env("CRON_SECRET");
  } catch {
    return false; // never accept requests when the secret is not configured
  }
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Map thrown errors to safe, useful responses (variable names only, never values). */
export function errorResponse(err: unknown, context: string): Response {
  if (err instanceof MissingEnvError) {
    return json({ error: err.message, missing: err.variable }, 503);
  }
  log("error", `${context}.failed`, { error: errorMessage(err) });
  return json({ error: "Something went wrong. Check the server logs and the run history for details." }, 500);
}
