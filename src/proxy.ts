import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * Optimistic gate: unauthenticated visitors never reach the dashboard. This is NOT the
 * only check - the dashboard page and every API route verify the session again.
 */
export async function proxy(request: NextRequest) {
  let authenticated = false;
  try {
    authenticated = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    authenticated = false;
  }
  if (!authenticated) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
