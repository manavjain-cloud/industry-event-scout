// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardData, DashboardEvent } from "@/lib/dashboard-data";
import { PREFS } from "./helpers";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/TubesBackground", () => ({ TubesBackground: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ev = (over: Partial<DashboardEvent> = {}): DashboardEvent => ({
  id: crypto.randomUUID(),
  title: "CIO Leadership Roundtable",
  startsOn: "2026-10-24",
  endsOn: null,
  timeText: null,
  city: "Bengaluru",
  venue: "ITC Gardenia",
  format: "in_person",
  registrationUrl: "https://reg.example.com/cio",
  registrationDeadline: null,
  deadline: { status: "unknown", daysRemaining: null, label: "Registration deadline not published / unknown" },
  score: 82,
  reason: "Targets CIOs in Bengaluru.",
  summary: "A roundtable for CIOs.",
  matchedFocusAreas: ["CIO roundtables"],
  sources: [{ url: "https://src.example.com/e", domain: "src.example.com" }],
  missingFields: [],
  ongoing: false,
  belowThreshold: false,
  rankingStale: false,
  dateBasis: "json_ld",
  lastVerifiedAt: "2026-10-12T00:00:00Z",
  ...over,
});

describe("EventCard", async () => {
  const { EventCard } = await import("@/components/dashboard/EventCard");

  it("shows an urgent deadline with an icon, words and the date - not colour alone", () => {
    render(<EventCard event={ev({ registrationDeadline: "2026-10-15", deadline: { status: "urgent", daysRemaining: 3, label: "Registration closes in 3 days" } })} rank={1} />);
    const alert = screen.getByRole("status");
    expect(alert).toHaveTextContent("Registration closes in 3 days");
    expect(alert).toHaveTextContent("15 Oct 2026");
    expect(alert.querySelector("svg")).not.toBeNull();
  });

  it("states honestly when the deadline, venue or city are unknown", () => {
    render(<EventCard event={ev({ venue: null, city: null, missingFields: ["city", "venue", "registration_deadline"], registrationUrl: null })} />);
    expect(screen.getByText(/Deadline not published/)).toBeInTheDocument();
    expect(screen.getByText(/Venue not confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/City not stated/)).toBeInTheDocument();
    expect(screen.getByText(/Not published by the source/)).toHaveTextContent(/city, venue/);
    expect(screen.queryByRole("link", { name: /^Register/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Event page: src.example.com/ })).toHaveAttribute("href", "https://src.example.com/e");
  });

  it("marks expired deadlines as possibly closed rather than urgent", () => {
    render(<EventCard event={ev({ registrationDeadline: "2026-10-10", deadline: { status: "expired", daysRemaining: -2, label: "x" } })} />);
    expect(screen.getByText(/Deadline passed/)).toHaveTextContent(/may be closed/);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows 'Not ranked' instead of a made-up score", () => {
    render(<EventCard event={ev({ score: null, reason: null, summary: null })} />);
    expect(screen.getByLabelText("Not ranked")).toBeInTheDocument();
    expect(screen.queryByText(/match \/ 100/)).toBeNull();
  });

  it("opens sources in a new tab safely", () => {
    render(<EventCard event={ev()} />);
    const link = screen.getByRole("link", { name: /Register/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });
});

describe("EventsPanel", async () => {
  const { EventsPanel } = await import("@/components/dashboard/EventsPanel");
  const events = [
    ev({ id: "a", title: "Alpha Fintech Summit", city: "Mumbai", score: 60, matchedFocusAreas: ["Fintech"], startsOn: "2026-10-30" }),
    ev({ id: "b", title: "Bravo CIO Roundtable", city: "Bengaluru", score: 90, matchedFocusAreas: ["CIO roundtables"], startsOn: "2026-10-20", registrationDeadline: "2026-10-15", deadline: { status: "urgent", daysRemaining: 3, label: "Registration closes in 3 days" } }),
    ev({ id: "c", title: "Charlie Startup Meetup", city: "Bangalore", score: 75, matchedFocusAreas: [], startsOn: "2026-10-25" }),
  ];
  const renderPanel = (list = events) => render(<EventsPanel events={list} focusAreas={["CIO roundtables", "Fintech"]} excludedNote={null} onRefresh={vi.fn()} refreshing={false} />);
  const titles = () => screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"));

  it("sorts by relevance by default, then by date", async () => {
    renderPanel();
    expect(titles()).toEqual(["Bravo CIO Roundtable", "Charlie Startup Meetup", "Alpha Fintech Summit"]);
    await userEvent.selectOptions(screen.getByLabelText("Sort events"), "date");
    expect(titles()).toEqual(["Bravo CIO Roundtable", "Charlie Startup Meetup", "Alpha Fintech Summit"].sort((x, y) => ({ "Bravo CIO Roundtable": 0, "Charlie Startup Meetup": 1, "Alpha Fintech Summit": 2 })[x]! - ({ "Bravo CIO Roundtable": 0, "Charlie Startup Meetup": 1, "Alpha Fintech Summit": 2 })[y]!));
  });

  it("filters by city (Bangalore and Bengaluru are the same city) and by category", async () => {
    renderPanel();
    await userEvent.selectOptions(screen.getByLabelText("Filter by city"), "Bengaluru");
    expect(titles()).toEqual(["Bravo CIO Roundtable", "Charlie Startup Meetup"]);
    await userEvent.selectOptions(screen.getByLabelText("Filter by focus area"), "CIO roundtables");
    expect(titles()).toEqual(["Bravo CIO Roundtable"]);
  });

  it("filters to events closing in under 7 days", async () => {
    renderPanel();
    await userEvent.click(screen.getByLabelText(/Closing in/));
    expect(titles()).toEqual(["Bravo CIO Roundtable"]);
  });

  it("shows a helpful empty state when filters match nothing, and can clear them", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText("Search events"), "zzzz-no-match");
    expect(screen.getByText("No events match these filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(titles()).toHaveLength(3);
  });

  it("explains an empty collection and offers a discovery run without inventing events", async () => {
    const onRefresh = vi.fn();
    render(<EventsPanel events={[]} focusAreas={[]} excludedNote={null} onRefresh={onRefresh} refreshing={false} />);
    expect(screen.getByText(/No events in the next window yet/)).toBeInTheDocument();
    expect(screen.getByText(/made up/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Run discovery now/ }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("DashboardShell", async () => {
  const { DashboardShell } = await import("@/components/dashboard/DashboardShell");
  const base: DashboardData = {
    integrations: { database: true, tavily: true, gemini: true, resend: true, cron: true },
    dbReady: true,
    dbError: null,
    prefs: PREFS,
    windowLabel: "12 Oct - 11 Nov, 2026",
    windowStart: "2026-10-12",
    windowEnd: "2026-11-11",
    events: [],
    excluded: null,
    runs: [],
    metrics: null,
    nextRun: { iso: "2026-10-19T02:30:00Z", label: "Mon 19 Oct 2026, 8:00 AM IST", windowLabel: "7:30 AM - 8:29 AM" },
    activeRunId: null,
    generatedAt: "2026-10-12T03:30:00Z",
  };

  it("stays useful with no events and no runs (empty state + schedule + tabs)", () => {
    render(<DashboardShell data={base} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("next 30 days");
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
    expect(screen.getByText(/Mon 19 Oct 2026/)).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
    expect(screen.getByRole("button", { name: /Refresh events/ })).toBeEnabled();
  });

  it("shows urgency in the summary tile and the last failed run without hiding the events", () => {
    const data: DashboardData = {
      ...base,
      events: [ev({ deadline: { status: "urgent", daysRemaining: 2, label: "Registration closes in 2 days" }, registrationDeadline: "2026-10-14" })],
      runs: [
        {
          id: "r1", runKey: "weekly:2026-W42", trigger: "cron", status: "failed", attempt: 1, startedAt: "2026-10-12T02:40:00Z", finishedAt: "2026-10-12T02:41:00Z", windowStart: null, windowEnd: null, timezone: null,
          candidatesCount: 0, retainedCount: 0, urgentCount: 0, emailStatus: "failed", emailProviderId: null, emailError: "Resend server error: boom", emailSentAt: null, digestSubject: null, digestReadMinutes: null, isTest: false,
          stages: [], errors: [{ stage: "send digest (Resend)", message: "Resend server error: boom" }], metrics: {},
        },
      ],
    };
    render(<DashboardShell data={data} />);
    const tile = screen.getAllByText("Closing in < 7 days")[0].closest("div")!.parentElement!;
    expect(within(tile).getByText("1")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument(); // last-run badge
    expect(screen.getByText("CIO Leadership Roundtable")).toBeInTheDocument();
  });

  it("shows setup guidance (names only) when the database is not configured", () => {
    render(<DashboardShell data={{ ...base, dbReady: false, dbError: "DATABASE_URL is not set.", prefs: null, nextRun: null, integrations: { database: false, tavily: false, gemini: false, resend: false, cron: true } }} />);
    expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
    expect(screen.getByText(/Database: DATABASE_URL is not set\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh events/ })).toBeDisabled();
  });

  it("starts a run, polls it and reports a throttled request clearly", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Please wait before starting another run.", retryAfterSeconds: 240 }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DashboardShell data={base} />);
    await userEvent.click(screen.getByRole("button", { name: /Refresh events/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Please wait.*4 min/);
    expect(fetchMock).toHaveBeenCalledWith("/api/runs", { method: "POST" });
  });

  it("switches tabs with the keyboard", async () => {
    render(<DashboardShell data={base} />);
    const first = screen.getByRole("tab", { name: /Events/ });
    first.focus();
    fireEvent.keyDown(first.parentElement!, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("tab", { name: /Digest preview/ })).toHaveAttribute("aria-selected", "true"));
  });
});

describe("SettingsPanel", async () => {
  const { SettingsPanel } = await import("@/components/dashboard/SettingsPanel");

  it("lets focus areas and cities be edited and surfaces server-side validation errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Some settings are invalid.", issues: [{ field: "recipientEmail", message: "Enter a valid email address" }] }), { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPanel prefs={PREFS} nextRunLabel="Mon 19 Oct" nextRunWindow="7:30 - 8:29" />);
    await userEvent.type(screen.getByPlaceholderText("Add a city"), "Pune{Enter}");
    expect(screen.getByRole("button", { name: "Remove Pune" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove Mumbai" }));
    await userEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    expect(await screen.findByText("Enter a valid email address")).toBeInTheDocument();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; method: string }];
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    expect(body.cities).toEqual(["Bengaluru", "Pune"]);
  });
});
