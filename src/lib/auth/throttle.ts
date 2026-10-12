import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import type { Db } from "@/lib/db/types";

const WINDOW_MINUTES = 10;
const MAX_FAILURES = 5;

/** Stable, non-reversible identifier for rate-limiting; the raw IP is never stored. */
export function clientFingerprint(request: Request): string {
  const ip = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  return createHash("sha256").update(`${ip}|${env("AUTH_SECRET")}`).digest("hex").slice(0, 32);
}

/** Login throttle backed by Neon so it survives serverless cold starts and multiple instances. */
export async function isLoginBlocked(db: Db, fingerprint: string): Promise<boolean> {
  const rows = await db.query<{ n: number }>(
    `select count(*)::int as n from auth_attempts
      where ip_hash = $1 and succeeded = false and attempted_at > now() - make_interval(mins => $2::int)`,
    [fingerprint, WINDOW_MINUTES],
  );
  return Number(rows[0]?.n ?? 0) >= MAX_FAILURES;
}

export async function recordLoginAttempt(db: Db, fingerprint: string, succeeded: boolean): Promise<void> {
  await db.query(`insert into auth_attempts (ip_hash, succeeded) values ($1, $2)`, [fingerprint, succeeded]);
  // Opportunistic cleanup keeps the table tiny without a separate job.
  await db.query(`delete from auth_attempts where attempted_at < now() - interval '1 day'`);
}
