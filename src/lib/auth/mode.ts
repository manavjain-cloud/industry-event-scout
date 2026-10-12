/**
 * Dashboard access mode.
 *
 * - `ADMIN_PASSWORD` set (any non-empty value): sign-in is required everywhere (default, recommended).
 * - `ADMIN_PASSWORD` absent/empty: the dashboard is open - no login screen. An operator decision for
 *   demos; run throttles, same-origin checks and the cron secret still apply.
 *
 * A password that is set but invalid (too short) keeps the login REQUIRED, so a typo can never
 * silently open the dashboard: sign-in simply fails until the value is fixed.
 */
export function authRequired(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.length > 0);
}
