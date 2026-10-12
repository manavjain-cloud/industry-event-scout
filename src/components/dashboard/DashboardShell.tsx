"use client";

import { CalendarClock, CalendarDays, CircleCheck, History, LoaderCircle, LogOut, Mail, RefreshCw, Settings, TriangleAlert, Radar, Siren } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { TubesBackground } from "@/components/TubesBackground";
import type { DashboardData } from "@/lib/dashboard-data";
import type { RunRow } from "@/lib/db/runs";
import { cn } from "@/lib/cn";
import { EventsPanel } from "./EventsPanel";
import { PreviewPanel, type PreviewData } from "./PreviewPanel";
import { RunsPanel } from "./RunsPanel";
import { SettingsPanel } from "./SettingsPanel";
import { SetupPanel } from "./SetupPanel";
import { Button, StatTile, StatusBadge } from "./ui";

type Tab = "events" | "preview" | "settings" | "runs";
const TABS: Array<{ id: Tab; label: string; icon: typeof CalendarDays }> = [
  { id: "events", label: "Events", icon: CalendarDays },
  { id: "preview", label: "Digest preview", icon: Mail },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "runs", label: "Runs & metrics", icon: History },
];

interface RunUi {
  phase: "idle" | "starting" | "running" | "finished" | "error";
  runId?: string;
  run?: RunRow;
  message?: string;
}

function relative(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function DashboardShell({ data }: { data: DashboardData }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("events");
  const prefs = data.prefs;
  const recipient = prefs?.recipientEmail ?? null;
  const tz = prefs?.timezone ?? "Asia/Kolkata";

  const activeRun = data.runs.find((r) => r.id === data.activeRunId);
  const [runUi, setRunUi] = useState<RunUi>(activeRun ? { phase: "running", runId: activeRun.id, run: activeRun } : { phase: "idle" });

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [mailMessage, setMailMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const events = data.events;
  const urgent = useMemo(() => events.filter((e) => e.deadline.status === "urgent").length, [events]);
  const lastRun = data.runs.find((r) => !r.isTest) ?? null;
  const running = runUi.phase === "starting" || runUi.phase === "running";

  // Poll the active run until it finishes, then refresh the server data.
  const pollingId = runUi.phase === "running" ? runUi.runId : undefined;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!pollingId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${pollingId}`, { cache: "no-store" });
        if (res.ok) {
          const { run } = (await res.json()) as { run: RunRow };
          if (stopped || !mounted.current) return;
          if (run.status !== "running") {
            setRunUi({ phase: "finished", runId: pollingId, run });
            router.refresh();
            return;
          }
          setRunUi({ phase: "running", runId: pollingId, run });
        }
      } catch {
        /* transient network error: keep polling */
      }
      if (!stopped) timer = setTimeout(tick, 2500);
    };
    let timer = setTimeout(tick, 1200);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pollingId, router]);

  const startRun = useCallback(async () => {
    setRunUi({ phase: "starting" });
    try {
      const res = await fetch("/api/runs", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; error?: string; retryAfterSeconds?: number };
      if (res.status === 202 && body.runId) {
        setRunUi({ phase: "running", runId: body.runId });
        return;
      }
      const wait = body.retryAfterSeconds ? ` Try again in ${Math.ceil(body.retryAfterSeconds / 60)} min.` : "";
      setRunUi({ phase: "error", message: `${body.error ?? "Could not start a run."}${wait}` });
    } catch {
      setRunUi({ phase: "error", message: "Could not reach the server." });
    }
  }, []);

  const loadPreview = useCallback(async () => {
    setPreviewing(true);
    setMailMessage(null);
    try {
      const res = await fetch("/api/digest/preview", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { preview?: PreviewData; error?: string };
      if (res.ok && body.preview) setPreview(body.preview);
      else setMailMessage({ ok: false, text: body.error ?? "Could not build the preview." });
    } catch {
      setMailMessage({ ok: false, text: "Could not reach the server." });
    } finally {
      setPreviewing(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    setTesting(true);
    setMailMessage(null);
    try {
      const res = await fetch("/api/digest/test-email", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      setMailMessage(res.ok && body.ok ? { ok: true, text: `Test email accepted by Resend and sent to ${recipient}. Check the inbox (and spam).` } : { ok: false, text: body.error ?? "Test email failed." });
      router.refresh();
    } catch {
      setMailMessage({ ok: false, text: "Could not reach the server." });
    } finally {
      setTesting(false);
    }
  }, [recipient, router]);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  function onTabKey(e: KeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.id === tab);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
      setTab(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  }

  const excludedNote = data.excluded
    ? [
        data.excluded.online ? `${data.excluded.online} online-only` : null,
        data.excluded.outsideTargetCities ? `${data.excluded.outsideTargetCities} outside your cities` : null,
      ]
        .filter(Boolean)
        .join(", ")
    : "";

  return (
    <div className="flex flex-1 flex-col">
      <header className="relative isolate overflow-hidden border-b border-line">
        <TubesBackground showShuffle={false} />
        <div className="relative z-10 mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-5 pb-6 pt-6">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm text-muted">
              <span className="grid size-7 place-items-center rounded-lg border border-line-strong bg-surface-2 text-cyan">
                <Radar className="size-4" aria-hidden="true" />
              </span>
              Industry Event Scout
            </div>
            <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">Opportunities for the next {prefs?.windowDays ?? 30} days</h1>
            <p className="mt-1 text-sm text-muted">{data.windowLabel ?? "Window available once the database is connected"}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={RefreshCw} onClick={startRun} busy={running} disabled={!data.dbReady}>
              {running ? "Refreshing..." : "Refresh events"}
            </Button>
            <Button variant="ghost" icon={LogOut} onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-6">
        <SetupPanel integrations={data.integrations} dbError={data.dbError} />

        <div aria-live="polite" className="mb-4">
          {(running || runUi.phase === "finished" || runUi.phase === "error") && <RunBanner ui={runUi} />}
        </div>

        {data.dbReady && prefs && (
          <>
            <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Events in window" value={events.length} icon={CalendarDays} hint={`${prefs.cities.join(", ")}`} />
              <StatTile
                label="Closing in < 7 days"
                value={urgent}
                icon={Siren}
                tone={urgent > 0 ? "rose" : "neutral"}
                hint={urgent > 0 ? "Registration deadlines needing action now" : "No known deadline is closing soon"}
              />
              <StatTile
                label="Last run"
                icon={History}
                value={lastRun ? <StatusBadge status={lastRun.status} /> : <span className="text-base text-muted">No runs yet</span>}
                hint={lastRun ? `${relative(lastRun.startedAt)} · email ${lastRun.emailStatus.replace("_", " ")}` : "Use “Refresh events” to run discovery"}
              />
              <StatTile
                label="Next weekly digest"
                icon={CalendarClock}
                tone="cyan"
                value={<span className="text-lg">{data.nextRun?.label ?? "-"}</span>}
                hint={prefs.weeklyEnabled ? (data.nextRun ? `Best effort: Vercel Hobby may run it any time ${data.nextRun.windowLabel}` : undefined) : "Weekly digest is switched off in Settings"}
              />
            </div>

            <div role="tablist" aria-label="Dashboard sections" onKeyDown={onTabKey} className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  id={`tab-${t.id}`}
                  role="tab"
                  type="button"
                  aria-selected={tab === t.id}
                  aria-controls={`panel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition",
                    tab === t.id ? "border-cyan text-ink" : "border-transparent text-muted hover:text-ink",
                  )}
                >
                  <t.icon className="size-4" aria-hidden="true" />
                  {t.label}
                </button>
              ))}
            </div>

            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
              {tab === "events" && <EventsPanel events={events} focusAreas={prefs.focusAreas} excludedNote={excludedNote || null} onRefresh={startRun} refreshing={running} />}
              {tab === "preview" && (
                <PreviewPanel preview={preview} onPreview={loadPreview} onTest={sendTest} previewing={previewing} testing={testing} recipient={prefs.recipientEmail} message={mailMessage} />
              )}
              {tab === "settings" && <SettingsPanel prefs={prefs} nextRunLabel={data.nextRun?.label ?? null} nextRunWindow={data.nextRun?.windowLabel ?? null} />}
              {tab === "runs" && <RunsPanel runs={data.runs} metrics={data.metrics} tz={tz} />}
            </div>
          </>
        )}
      </main>

      <footer className="border-t border-line px-5 py-5 text-center text-xs text-faint">
        AI scores are decision support. Always confirm dates, venues and deadlines on the original source before registering - you decide what to attend.
      </footer>
    </div>
  );
}

function RunBanner({ ui }: { ui: RunUi }) {
  if (ui.phase === "error") {
    return (
      <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose/50 bg-rose-bg px-4 py-3 text-sm text-rose">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {ui.message}
      </div>
    );
  }
  const run = ui.run;
  if (ui.phase === "finished" && run) {
    const failed = run.status === "failed";
    return (
      <div className={cn("flex items-start gap-2 rounded-xl border px-4 py-3 text-sm", failed ? "border-rose/50 bg-rose-bg text-rose" : run.status === "partial" ? "border-amber/40 bg-amber/10 text-amber" : "border-lime/40 bg-lime/10 text-lime")}>
        {failed || run.status === "partial" ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
        <div>
          <p className="font-medium">
            Refresh {run.status === "succeeded" ? "finished" : run.status === "partial" ? "finished with problems" : "failed"}: {run.retainedCount} event{run.retainedCount === 1 ? "" : "s"} in the digest, {run.urgentCount} closing soon.
          </p>
          {run.errors.slice(0, 3).map((e, i) => (
            <p key={i} className="mt-1 text-xs opacity-90">
              {e.stage}: {e.message}
            </p>
          ))}
          <p className="mt-1 text-xs opacity-80">Details are in “Runs &amp; metrics”.</p>
        </div>
      </div>
    );
  }
  const done = ui.run?.stages ?? [];
  return (
    <div className="rounded-xl border border-cyan/40 bg-cyan/5 px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-cyan">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Searching the web and ranking events - this can take a few minutes.
      </p>
      {done.length > 0 && (
        <ul className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
          {done.map((s, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <StatusBadge status={s.status} kind="stage" />
              <span>{s.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
