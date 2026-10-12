import { cookies } from "next/headers";
import { authRequired } from "./mode";
import { SESSION_COOKIE, verifySessionToken } from "./session";

/** Server Component / layout check. Fails closed if AUTH_SECRET is missing or the cookie is bad. */
export async function isAdminServer(): Promise<boolean> {
  if (!authRequired()) return true;
  try {
    return await verifySessionToken((await cookies()).get(SESSION_COOKIE)?.value);
  } catch {
    return false;
  }
}
