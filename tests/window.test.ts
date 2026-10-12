import { describe, expect, it } from "vitest";
import { classifyAgainstWindow, computeWindow, isOngoing } from "@/lib/dates/window";

const NOW = new Date("2026-10-12T03:30:00Z");
const W = computeWindow(NOW, "Asia/Kolkata", 30);

describe("computeWindow", () => {
  it("spans today through today+30 in the configured timezone", () => {
    expect(W).toMatchObject({ start: "2026-10-12", end: "2026-11-11" });
  });
  it("uses the timezone's today, not UTC's", () => {
    const instant = new Date("2026-10-12T20:00:00Z"); // already 13 Oct in IST
    expect(computeWindow(instant, "Asia/Kolkata", 30).start).toBe("2026-10-13");
    expect(computeWindow(instant, "UTC", 30).start).toBe("2026-10-12");
  });
});

describe("classifyAgainstWindow (upcoming 30-day filtering)", () => {
  it("keeps events today, tomorrow and on the last window day", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-10-12" }, W)).toBe("in_window");
    expect(classifyAgainstWindow({ startsOn: "2026-10-13" }, W)).toBe("in_window");
    expect(classifyAgainstWindow({ startsOn: "2026-11-11" }, W)).toBe("in_window");
  });
  it("rejects events beyond the window", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-11-12" }, W)).toBe("too_far");
    expect(classifyAgainstWindow({ startsOn: "2027-01-01" }, W)).toBe("too_far");
  });
  it("rejects events that already ended", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-10-11" }, W)).toBe("ended");
    expect(classifyAgainstWindow({ startsOn: "2026-10-01", endsOn: "2026-10-05" }, W)).toBe("ended");
  });
  it("keeps multi-day events that started earlier but have not ended", () => {
    const ev = { startsOn: "2026-10-10", endsOn: "2026-10-13" };
    expect(classifyAgainstWindow(ev, W)).toBe("in_window");
    expect(isOngoing(ev, W)).toBe(true);
  });
  it("ignores an end date earlier than the start date", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-10-20", endsOn: "2026-10-01" }, W)).toBe("in_window");
  });
  it("flags invalid dates instead of guessing", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-13-40" }, W)).toBe("invalid");
    expect(classifyAgainstWindow({ startsOn: "" }, W)).toBe("invalid");
  });
});

describe("recurring series are not mistaken for one ongoing event (found in live data)", () => {
  it("rejects a listing that started long ago and ends months from now", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-05-01", endsOn: "2027-03-31" }, W)).toBe("series");
    expect(classifyAgainstWindow({ startsOn: "2026-06-06", endsOn: "2026-12-20" }, W)).toBe("series");
  });
  it("still keeps a genuine multi-day conference that is under way", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-10-10", endsOn: "2026-10-14" }, W)).toBe("in_window");
  });
  it("keeps a long listing that STARTS inside the window (its start date is real)", () => {
    expect(classifyAgainstWindow({ startsOn: "2026-10-20", endsOn: "2027-01-31" }, W)).toBe("in_window");
  });
});
