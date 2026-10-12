import { describe, expect, it } from "vitest";
import { evaluateDeadline } from "@/lib/dates/deadlines";

const TZ = "Asia/Kolkata";
// 2026-10-12 09:00 IST = 03:30 UTC
const NOW = new Date("2026-10-12T03:30:00Z");

describe("evaluateDeadline - date-only deadlines (strictly fewer than 7 days)", () => {
  it.each([
    ["2026-10-18", 6, "urgent"],
    ["2026-10-15", 3, "urgent"],
    ["2026-10-13", 1, "urgent"],
    ["2026-10-12", 0, "urgent"],
    ["2026-10-19", 7, "upcoming"], // exactly seven days: NOT urgent
    ["2026-10-20", 8, "upcoming"],
    ["2026-11-30", 49, "upcoming"],
  ])("deadline %s is %i days away -> %s", (date, days, status) => {
    const r = evaluateDeadline({ date }, NOW, TZ);
    expect(r.daysRemaining).toBe(days);
    expect(r.status).toBe(status);
  });

  it("marks a passed deadline as expired, never urgent", () => {
    const r = evaluateDeadline({ date: "2026-10-11" }, NOW, TZ);
    expect(r.status).toBe("expired");
    expect(r.daysRemaining).toBe(-1);
    expect(r.label).toMatch(/passed/i);
  });

  it("treats a missing deadline as unknown, not as a date", () => {
    expect(evaluateDeadline(null, NOW, TZ)).toMatchObject({ status: "unknown", daysRemaining: null });
    expect(evaluateDeadline({}, NOW, TZ).status).toBe("unknown");
    expect(evaluateDeadline({ date: null, at: null }, NOW, TZ).status).toBe("unknown");
  });

  it("treats a malformed date as unknown rather than guessing", () => {
    expect(evaluateDeadline({ date: "2026-02-30" }, NOW, TZ).status).toBe("unknown");
    expect(evaluateDeadline({ date: "next friday" }, NOW, TZ).status).toBe("unknown");
  });
});

describe("evaluateDeadline - timezone and midnight handling", () => {
  it("uses the configured timezone's calendar day, not UTC's", () => {
    // 2026-10-12 23:30 UTC is already 2026-10-13 05:00 in IST.
    const lateUtc = new Date("2026-10-12T23:30:00Z");
    expect(evaluateDeadline({ date: "2026-10-19" }, lateUtc, "Asia/Kolkata")).toMatchObject({
      daysRemaining: 6,
      status: "urgent",
    });
    // The same instant is still 2026-10-12 in UTC -> exactly 7 days -> not urgent.
    expect(evaluateDeadline({ date: "2026-10-19" }, lateUtc, "UTC")).toMatchObject({
      daysRemaining: 7,
      status: "upcoming",
    });
  });

  it("a date-only deadline stays open for the whole of its local day", () => {
    const lastMinute = new Date("2026-10-12T18:29:00Z"); // 23:59 IST on 12 Oct
    expect(evaluateDeadline({ date: "2026-10-12" }, lastMinute, TZ)).toMatchObject({
      status: "urgent",
      daysRemaining: 0,
    });
    const justAfterMidnight = new Date("2026-10-12T18:31:00Z"); // 00:01 IST on 13 Oct
    expect(evaluateDeadline({ date: "2026-10-12" }, justAfterMidnight, TZ).status).toBe("expired");
  });

  it("flips from upcoming to urgent exactly at local midnight", () => {
    const before = new Date("2026-10-12T18:29:59Z"); // 23:59:59 IST on 12 Oct: 7 days to 19 Oct
    const after = new Date("2026-10-12T18:30:00Z"); // 00:00:00 IST on 13 Oct: 6 days
    expect(evaluateDeadline({ date: "2026-10-19" }, before, TZ).status).toBe("upcoming");
    expect(evaluateDeadline({ date: "2026-10-19" }, after, TZ).status).toBe("urgent");
  });

  it("is DST-proof for timezones that observe it", () => {
    // US clocks go back on 2026-11-01; 7 calendar days before 2026-11-05 is 2026-10-29.
    const now = new Date("2026-10-29T16:00:00Z");
    expect(evaluateDeadline({ date: "2026-11-05" }, now, "America/New_York")).toMatchObject({
      daysRemaining: 7,
      status: "upcoming",
    });
  });
});

describe("evaluateDeadline - exact instants", () => {
  it("is urgent just under 7x24h away and not urgent at exactly 7x24h", () => {
    const justUnder = new Date(NOW.getTime() + 7 * 86_400_000 - 1000).toISOString();
    const exactly = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    expect(evaluateDeadline({ at: justUnder }, NOW, TZ).status).toBe("urgent");
    expect(evaluateDeadline({ at: exactly }, NOW, TZ).status).toBe("upcoming");
  });

  it("is expired when the instant has passed or equals now", () => {
    expect(evaluateDeadline({ at: NOW.toISOString() }, NOW, TZ).status).toBe("expired");
    expect(evaluateDeadline({ at: "2026-10-12T03:29:59Z" }, NOW, TZ).status).toBe("expired");
  });

  it("prefers the exact instant over a date when both exist", () => {
    const r = evaluateDeadline({ date: "2026-12-31", at: "2026-10-14T10:00:00Z" }, NOW, TZ);
    expect(r.status).toBe("urgent");
  });
});
