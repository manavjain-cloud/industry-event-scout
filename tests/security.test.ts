import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRETS = {
  CRON_SECRET: "cron-secret-for-tests-1234567890",
  ADMIN_PASSWORD: "correct horse battery staple",
  AUTH_SECRET: "auth-secret-for-tests-that-is-at-least-32-chars-long",
};
beforeEach(() => {
  Object.assign(process.env, SECRETS);
  delete process.env.DATABASE_URL;
  vi.resetModules();
});

const req = (url: string, init: RequestInit = {}) => new Request(`http://localhost:3000${url}`, init);

async function sessionCookie(): Promise<string> {
  const { createSessionToken, SESSION_COOKIE } = await import("@/lib/auth/session");
  return `${SESSION_COOKIE}=${await createSessionToken()}`;
}

describe("protected cron endpoint", () => {
  it("rejects requests with no, wrong or malformed credentials and does no work", async () => {
    const runWeeklyDigest = vi.fn();
    vi.doMock("@/lib/pipeline/entrypoints", () => ({ runWeeklyDigest }));
    vi.doMock("@/lib/pipeline/deps", () => ({ createLiveDeps: vi.fn() }));
    const { GET } = await import("@/app/api/cron/weekly-digest/route");

    for (const headers of [{} as Record<string, string>, { authorization: "Bearer wrong" }, { authorization: SECRETS.CRON_SECRET }, { authorization: `Basic ${SECRETS.CRON_SECRET}` }, { authorization: "Bearer " }]) {
      const res = await GET(req("/api/cron/weekly-digest", { headers }));
      expect(res.status).toBe(401);
    }
    expect(runWeeklyDigest).not.toHaveBeenCalled();
  });

  it("refuses everything when CRON_SECRET is not configured (never open by default)", async () => {
    delete process.env.CRON_SECRET;
    const runWeeklyDigest = vi.fn();
    vi.doMock("@/lib/pipeline/entrypoints", () => ({ runWeeklyDigest }));
    vi.doMock("@/lib/pipeline/deps", () => ({ createLiveDeps: vi.fn() }));
    const { GET } = await import("@/app/api/cron/weekly-digest/route");
    expect((await GET(req("/api/cron/weekly-digest", { headers: { authorization: "Bearer undefined" } }))).status).toBe(401);
    expect((await GET(req("/api/cron/weekly-digest", { headers: { authorization: "Bearer " } }))).status).toBe(401);
    expect(runWeeklyDigest).not.toHaveBeenCalled();
  });

  it("runs the weekly digest for the correct bearer secret and reports the outcome", async () => {
    const runWeeklyDigest = vi.fn(async () => ({
      outcome: "completed" as const,
      summary: { runId: "r1", status: "succeeded" as const, emailStatus: "sent" as const, retained: 4, urgent: 1, errors: [] },
    }));
    vi.doMock("@/lib/pipeline/entrypoints", () => ({ runWeeklyDigest }));
    vi.doMock("@/lib/pipeline/deps", () => ({ createLiveDeps: vi.fn(() => ({})) }));
    const { GET } = await import("@/app/api/cron/weekly-digest/route");
    const res = await GET(req("/api/cron/weekly-digest", { headers: { authorization: `Bearer ${SECRETS.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "succeeded", emailStatus: "sent", retained: 4, urgent: 1 });
    expect(runWeeklyDigest).toHaveBeenCalledTimes(1);
  });

  it("answers 200 for a skipped duplicate and 500 for a failed run (visible in Vercel cron logs)", async () => {
    const runWeeklyDigest = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "skipped", reason: "already_sent", runId: "r1" })
      .mockResolvedValueOnce({ outcome: "completed", summary: { runId: "r2", status: "failed", emailStatus: "failed", retained: 0, urgent: 0, errors: [] } });
    vi.doMock("@/lib/pipeline/entrypoints", () => ({ runWeeklyDigest }));
    vi.doMock("@/lib/pipeline/deps", () => ({ createLiveDeps: vi.fn(() => ({})) }));
    const { GET } = await import("@/app/api/cron/weekly-digest/route");
    const headers = { authorization: `Bearer ${SECRETS.CRON_SECRET}` };
    const dup = await GET(req("/api/cron/weekly-digest", { headers }));
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ skipped: "already_sent" });
    expect((await GET(req("/api/cron/weekly-digest", { headers }))).status).toBe(500);
  });
});

describe("unauthorized dashboard access", () => {
  it.each([
    ["@/app/api/preferences/route", "GET", "/api/preferences"],
    ["@/app/api/preferences/route", "PUT", "/api/preferences"],
    ["@/app/api/runs/route", "GET", "/api/runs"],
    ["@/app/api/runs/route", "POST", "/api/runs"],
    ["@/app/api/digest/preview/route", "POST", "/api/digest/preview"],
    ["@/app/api/digest/test-email/route", "POST", "/api/digest/test-email"],
  ])("%s %s returns 401 without a session and touches no service", async (mod, method, url) => {
    const startManual = vi.fn();
    const deps = vi.fn();
    vi.doMock("@/lib/pipeline/entrypoints", () => ({ startManualRun: startManual, previewDigest: startManual, sendTestEmail: startManual }));
    vi.doMock("@/lib/pipeline/deps", () => ({ createLiveDeps: deps }));
    const handler = (await import(/* @vite-ignore */ mod))[method] as (r: Request) => Promise<Response>;
    const res = await handler(req(url, { method, body: method === "GET" ? undefined : "{}", headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(401);
    expect(startManual).not.toHaveBeenCalled();
    expect(deps).not.toHaveBeenCalled();
  });

  it("rejects a forged or tampered session cookie", async () => {
    const { GET } = await import("@/app/api/preferences/route");
    const good = await sessionCookie();
    const forged = good.slice(0, -4) + "AAAA";
    expect((await GET(req("/api/preferences", { headers: { cookie: forged } }))).status).toBe(401);
    expect((await GET(req("/api/preferences", { headers: { cookie: "scout_session=not-a-jwt" } }))).status).toBe(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ role: "admin" }).setProtectedHeader({ alg: "HS256" }).setSubject("admin").setExpirationTime("1h").sign(new TextEncoder().encode("x".repeat(40)));
    const { GET } = await import("@/app/api/preferences/route");
    expect((await GET(req("/api/preferences", { headers: { cookie: `scout_session=${token}` } }))).status).toBe(401);
  });

  it("accepts a valid session but refuses a cross-origin mutation", async () => {
    const getDb = vi.fn(() => ({}));
    vi.doMock("@/lib/db/client", () => ({ getDb }));
    const savePreferences = vi.fn(async () => ({}));
    vi.doMock("@/lib/db/preferences", () => ({ getPreferences: vi.fn(), savePreferences }));
    const { PUT } = await import("@/app/api/preferences/route");
    const cookie = await sessionCookie();
    const body = JSON.stringify({ recipientEmail: "a@b.co", timezone: "Asia/Kolkata", focusAreas: ["AI"], cities: ["Pune"], windowDays: 30, maxDigestEvents: 10, weeklyEnabled: true });
    const cross = await PUT(req("/api/preferences", { method: "PUT", body, headers: { cookie, origin: "https://evil.example", host: "localhost:3000" } }));
    expect(cross.status).toBe(403);
    expect(savePreferences).not.toHaveBeenCalled();
    const same = await PUT(req("/api/preferences", { method: "PUT", body, headers: { cookie, origin: "http://localhost:3000", host: "localhost:3000" } }));
    expect(same.status).toBe(200);
    expect(savePreferences).toHaveBeenCalledTimes(1);
  });

  it("validates settings server-side", async () => {
    vi.doMock("@/lib/db/client", () => ({ getDb: vi.fn(() => ({})) }));
    vi.doMock("@/lib/db/preferences", () => ({ getPreferences: vi.fn(), savePreferences: vi.fn() }));
    const { PUT } = await import("@/app/api/preferences/route");
    const cookie = await sessionCookie();
    const res = await PUT(req("/api/preferences", { method: "PUT", body: JSON.stringify({ recipientEmail: "nope", timezone: "Mars/Base", focusAreas: [], cities: [], windowDays: 3, maxDigestEvents: 99, weeklyEnabled: "yes" }), headers: { cookie } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.length).toBeGreaterThanOrEqual(5);
  });
});

describe("login", () => {
  it("sets an HttpOnly, SameSite=Strict cookie for the right password only", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const bad = await POST(req("/api/auth/login", { method: "POST", body: JSON.stringify({ password: "wrong" }) }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();

    const good = await POST(req("/api/auth/login", { method: "POST", body: JSON.stringify({ password: SECRETS.ADMIN_PASSWORD }) }));
    expect(good.status).toBe(200);
    const cookie = good.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/scout_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(await good.text()).not.toContain(SECRETS.ADMIN_PASSWORD);
  });

  it("blocks brute force after repeated failures (throttle stored in the database)", async () => {
    process.env.DATABASE_URL = "postgres://user:pass@localhost/db";
    const attempts: boolean[] = [];
    const fakeDb = {
      query: vi.fn(async (text: string) => (/count\(\*\)/.test(text) ? [{ n: attempts.filter((a) => !a).length }] : [])),
      transaction: vi.fn(),
    };
    vi.doMock("@/lib/db/client", () => ({ getDb: () => fakeDb }));
    vi.doMock("@/lib/auth/throttle", async () => {
      const real = await vi.importActual<typeof import("@/lib/auth/throttle")>("@/lib/auth/throttle");
      return { ...real, recordLoginAttempt: vi.fn(async (_db: unknown, _fp: string, ok: boolean) => void attempts.push(ok)) };
    });
    const { POST } = await import("@/app/api/auth/login/route");
    const attempt = (password: string) => POST(req("/api/auth/login", { method: "POST", body: JSON.stringify({ password }), headers: { "x-forwarded-for": "203.0.113.9" } }));
    for (let i = 0; i < 5; i++) expect((await attempt("nope")).status).toBe(401);
    const blocked = await attempt(SECRETS.ADMIN_PASSWORD); // even the right password is refused while blocked
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("600");
  });

  it("refuses cross-origin login attempts", async () => {
    const { POST } = await import("@/app/api/auth/login/route");
    const res = await POST(req("/api/auth/login", { method: "POST", body: JSON.stringify({ password: SECRETS.ADMIN_PASSWORD }), headers: { origin: "https://evil.example", host: "localhost:3000" } }));
    expect(res.status).toBe(403);
  });
});

describe("proxy gate for the dashboard", () => {
  it("redirects visitors without a session to /login", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const res = await proxy(new NextRequest("http://localhost:3000/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login");
  });
  it("lets an authenticated visitor through", async () => {
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const res = await proxy(new NextRequest("http://localhost:3000/dashboard", { headers: { cookie: await sessionCookie() } }));
    expect(res.status).toBe(200);
  });
});

describe("configuration errors never leak secret values", () => {
  it("names the missing variable but not any value", async () => {
    delete process.env.GEMINI_API_KEY;
    const { env, MissingEnvError } = await import("@/lib/env");
    try {
      env("GEMINI_API_KEY");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as Error).message).toContain("GEMINI_API_KEY");
    }
  });
});
