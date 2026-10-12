"use client";

import { ChevronDown, History, Mail } from "lucide-react";
import { useState } from "react";
import type { OperationalMetrics } from "@/lib/dashboard-data";
import type { RunRow } from "@/lib/db/runs";
import { cn } from "@/lib/cn";
import { Chip, EmptyState, StatTile, StatusBadge } from "./ui";

const TRIGGER_LABEL: Record<string, string> = { cron: "Weekly (scheduled)", manual: "Manual refresh", test_email: "Test email" };
const CATEGORY_TONE: Record<string, "cyan" | "violet" | "amber" | "lime" | "neutral"> = {
  TRIGGER: "cyan",
  INPUT: "lime",
  CONTEXT: "violet",
  PROCESSING: "amber",
  AI: "lime",
  OUTPUT: "neutral",
};

function fmt(iso: string | null, tz: string): string {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

function duration(run: RunRow): string {
  if (!run.finishedAt) return run.status === "running" ? "in progress" : "-";
  const s = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function MetricsPanel({ m }: { m: OperationalMetrics }) {
  const rate = (v: number | null) => (v === null ? "-" : `${v}%`);
  return (
    <section aria-labelledby="metrics-h" className="mb-8">
      <h2 id="metrics-h" className="mb-1 text-base font-semibold">
        Operational metrics
      </h2>
      <p className="mb-4 max-w-3xl text-sm text-muted">
        Measured from real runs. Time saved and business impact are <strong>not</strong> claimed: the {m.manualBaselineMinutes}-minute manual search is a baseline reported in the brief, and the
        digest read time below is an estimate from word count.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Runs completed" value={rate(m.runCompletionRate)} hint={`${m.runsCompleted} finished with output (not counting tests)`} />
        <StatTile label="Weekly email delivery" value={rate(m.emailDeliveryRate)} hint={`${m.weeklyRunsFinished} scheduled run(s) recorded`} />
        <StatTile label="Unique events in window" value={m.uniqueEventsInWindow} hint={m.duplicatesMergedLatest === null ? "No run recorded yet" : `${m.duplicatesMergedLatest} duplicate listing(s) merged in the latest run`} />
        <StatTile
          label="Latest digest"
          value={m.relevantInLatestDigest ?? "-"}
          hint={m.relevantInLatestDigest === null ? "No digest yet" : `${m.urgentInLatestDigest ?? 0} closing in < 7 days · ~${m.digestReadMinutes ?? "?"} min read vs ${m.manualBaselineMinutes} min manual baseline`}
        />
        <StatTile label="Deadline coverage" value={rate(m.deadlineKnownShare)} hint="Events whose source states a registration deadline. The rest show as unknown." />
        <StatTile
          label="Date provenance (latest digest)"
          value={m.datesFromMarkupLatest === null ? "-" : `${m.datesFromMarkupLatest} / ${m.datesFromQuotedEvidenceLatest}`}
          hint="Dates from source markup / dates verified against a quoted source sentence. Unverifiable dates are discarded."
        />
        <StatTile label="Tavily credits (30 days)" value={m.tavilyCredits30d} hint="Basic search = 1 credit each" />
        <StatTile label="Gemini calls (30 days)" value={m.geminiCalls30d} hint={m.latestRunDurationSeconds === null ? undefined : `Latest run took ${m.latestRunDurationSeconds}s`} />
      </div>
    </section>
  );
}

function RunItem({ run, tz }: { run: RunRow; tz: string }) {
  const [open, setOpen] = useState(run.status === "failed" || run.status === "running");
  const id = `run-${run.id}`;
  return (
    <li className={cn("rounded-xl border bg-surface", run.status === "failed" ? "border-rose/50" : "border-line")}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id} className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-left">
        <ChevronDown className={cn("size-4 shrink-0 text-faint transition", open ? "rotate-0" : "-rotate-90")} aria-hidden="true" />
        <span className="min-w-36 text-sm font-medium">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</span>
        <span className="text-sm text-muted">{fmt(run.startedAt, tz)}</span>
        <StatusBadge status={run.status} />
        {run.trigger !== "manual" && <StatusBadge status={run.emailStatus} kind="email" />}
        <span className="ml-auto flex items-center gap-3 text-xs text-muted">
          {run.trigger !== "test_email" && (
            <span>
              {run.retainedCount} in digest · {run.urgentCount} urgent
            </span>
          )}
          <span>{duration(run)}</span>
          {run.attempt > 1 && <Chip tone="amber">attempt {run.attempt}</Chip>}
        </span>
      </button>
      {open && (
        <div id={id} className="space-y-4 border-t border-line px-4 py-4 text-sm">
          {run.digestSubject && (
            <p className="flex items-start gap-2 text-muted">
              <Mail className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden="true" />
              <span>
                {run.digestSubject}
                {run.emailSentAt ? ` - accepted by Resend ${fmt(run.emailSentAt, tz)}` : ""}
                {run.emailProviderId ? <span className="ml-1 font-mono text-xs text-faint">({run.emailProviderId})</span> : null}
              </span>
            </p>
          )}
          {run.emailError && <p className="rounded-lg border border-rose/40 bg-rose-bg px-3 py-2 text-rose">Email: {run.emailError}</p>}
          {run.stages.length > 0 && (
            <ol className="space-y-1.5">
              {run.stages.map((s, i) => (
                <li key={`${s.name}-${i}`} className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <Chip tone={CATEGORY_TONE[s.category] ?? "neutral"} className="w-24 justify-center font-mono text-[10px] uppercase">
                    {s.category}
                  </Chip>
                  <span className="min-w-52 font-medium">{s.name}</span>
                  <StatusBadge status={s.status} kind="stage" />
                  <span className="text-xs text-muted">{(s.durationMs / 1000).toFixed(1)}s</span>
                  {(s.detail || s.error) && <span className={cn("basis-full pl-[7.5rem] text-xs leading-relaxed", s.error ? "text-rose" : "text-muted")}>{s.error ?? s.detail}</span>}
                </li>
              ))}
            </ol>
          )}
          {run.errors.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-rose">Errors recorded</h4>
              <ul className="space-y-1 text-xs text-muted">
                {run.errors.map((e, i) => (
                  <li key={i}>
                    <span className="font-medium text-ink">{e.stage}:</span> {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="font-mono text-[11px] text-faint">
            {run.runKey}
            {run.windowStart ? ` · window ${run.windowStart} to ${run.windowEnd}` : ""}
          </p>
        </div>
      )}
    </li>
  );
}

export function RunsPanel({ runs, metrics, tz }: { runs: RunRow[]; metrics: OperationalMetrics | null; tz: string }) {
  return (
    <div>
      {metrics && <MetricsPanel m={metrics} />}
      <h2 className="mb-3 text-base font-semibold">Run history</h2>
      {runs.length === 0 ? (
        <EmptyState icon={History} title="No runs recorded yet">
          Weekly runs, manual refreshes and test emails will appear here with the outcome of every stage and any errors.
        </EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {runs.map((r) => (
            <RunItem key={r.id} run={r} tz={tz} />
          ))}
        </ul>
      )}
    </div>
  );
}
