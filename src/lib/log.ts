/** Safe logging: structured, no secrets, no recipient addresses. */
const SECRET_PATTERNS = [/tvly-[A-Za-z0-9_-]+/g, /AIza[0-9A-Za-z_-]{20,}/g, /AQ\.[0-9A-Za-z_-]{20,}/g, /napi_[0-9a-z]{20,}/g, /re_[A-Za-z0-9_]{10,}/g, /postgres(ql)?:\/\/[^\s"']+/g];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, "[redacted]"), text);
}

export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "Unknown error";
  return redact(raw).slice(0, 500);
}

export function log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    safe[k] = typeof v === "string" ? redact(v).slice(0, 300) : v;
  }
  const line = JSON.stringify({ level, event, ...safe });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
