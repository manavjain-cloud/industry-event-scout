import { NextResponse } from "next/server";
import { isSameOrigin, json } from "@/lib/auth/guard";
import { SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin request refused" }, 403);
  const res = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "strict", path: "/", maxAge: 0 });
  return res;
}
