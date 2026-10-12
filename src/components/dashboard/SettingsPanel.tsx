"use client";

import { CircleCheck, Plus, Save, TriangleAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import type { Preferences } from "@/lib/types";
import { Button, Chip } from "./ui";

interface FieldIssue {
  field: string;
  message: string;
}

const inputCls = "w-full rounded-lg border border-line-strong bg-bg px-3 py-2.5 text-sm outline-none placeholder:text-faint focus:border-cyan aria-[invalid=true]:border-rose";

function TagInput({ label, hint, values, onChange, placeholder, error }: { label: string; hint: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; error?: string }) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const v = raw.trim();
    if (v.length < 2) return;
    if (!values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      <p id={`${id}-hint`} className="mb-2 text-xs text-muted">
        {hint}
      </p>
      <div className="mb-2 flex flex-wrap gap-1.5" aria-label={`${label} list`}>
        {values.map((v) => (
          <Chip key={v} tone="cyan" className="gap-1.5 py-1 pr-1 text-sm">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="rounded p-0.5 hover:bg-cyan/20">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </Chip>
        ))}
        {values.length === 0 && <span className="text-xs text-rose">Add at least one.</span>}
      </div>
      <div className="flex gap-2">
        <input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => add(draft)}
          placeholder={placeholder}
          aria-describedby={`${id}-hint`}
          aria-invalid={error ? true : undefined}
          className={inputCls}
        />
        <Button icon={Plus} onClick={() => add(draft)} aria-label={`Add to ${label}`}>
          Add
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-rose">{error}</p>}
    </div>
  );
}

export function SettingsPanel({ prefs, nextRunLabel, nextRunWindow }: { prefs: Preferences; nextRunLabel: string | null; nextRunWindow: string | null }) {
  const router = useRouter();
  const [form, setForm] = useState({
    recipientEmail: prefs.recipientEmail ?? "",
    timezone: prefs.timezone,
    focusAreas: prefs.focusAreas,
    cities: prefs.cities,
    windowDays: prefs.windowDays,
    maxDigestEvents: prefs.maxDigestEvents,
    weeklyEnabled: prefs.weeklyEnabled,
  });
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const tzListId = useId();
  const timezones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return ["Asia/Kolkata", "UTC"];
    }
  }, []);
  const issue = (field: string) => issues.find((i) => i.field === field || i.field.startsWith(`${field}.`))?.message;

  async function save() {
    setBusy(true);
    setResult(null);
    setIssues([]);
    try {
      const res = await fetch("/api/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, windowDays: Number(form.windowDays), maxDigestEvents: Number(form.maxDigestEvents) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: FieldIssue[] };
      if (res.ok) {
        setResult({ ok: true, message: "Saved. The next run uses these settings." });
        router.refresh();
      } else {
        setIssues(body.issues ?? []);
        setResult({ ok: false, message: body.error ?? "Could not save settings." });
      }
    } catch {
      setResult({ ok: false, message: "Could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="grid max-w-3xl gap-6"
    >
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="text-base font-semibold">What to look for</h2>
        <p className="mt-1 text-sm text-muted">Searches, filters and relevance ranking all use these. Changing them needs no code change.</p>
        <div className="mt-5 grid gap-6">
          <TagInput
            label="Professional focus areas"
            hint="Topics or audiences, e.g. “CIO and CXO roundtables”, “Supply chain”. Press Enter to add."
            values={form.focusAreas}
            onChange={(focusAreas) => setForm({ ...form, focusAreas })}
            placeholder="Add a focus area"
            error={issue("focusAreas")}
          />
          <TagInput
            label="Target cities"
            hint="Events in a known city outside this list are excluded. “Delhi NCR” also covers Delhi, Gurugram and Noida."
            values={form.cities}
            onChange={(cities) => setForm({ ...form, cities })}
            placeholder="Add a city"
            error={issue("cities")}
          />
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="text-base font-semibold">Digest delivery</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
              Recipient email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={form.recipientEmail}
              onChange={(e) => setForm({ ...form, recipientEmail: e.target.value })}
              placeholder="you@example.com"
              aria-invalid={issue("recipientEmail") ? true : undefined}
              className={inputCls}
            />
            {issue("recipientEmail") && <p className="mt-1 text-xs text-rose">{issue("recipientEmail")}</p>}
          </div>
          <div>
            <label htmlFor="tz" className="mb-1.5 block text-sm font-medium">
              Timezone
            </label>
            <input
              id="tz"
              list={tzListId}
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              aria-invalid={issue("timezone") ? true : undefined}
              className={inputCls}
            />
            <datalist id={tzListId}>
              {timezones.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            {issue("timezone") && <p className="mt-1 text-xs text-rose">{issue("timezone")}</p>}
          </div>
          <div>
            <label htmlFor="max" className="mb-1.5 block text-sm font-medium">
              Max events per email
            </label>
            <input id="max" type="number" min={3} max={25} value={form.maxDigestEvents} onChange={(e) => setForm({ ...form, maxDigestEvents: Number(e.target.value) })} className={inputCls} />
            <p className="mt-1 text-xs text-muted">Keeps the digest scannable in under five minutes.</p>
          </div>
          <div>
            <label htmlFor="win" className="mb-1.5 block text-sm font-medium">
              Look-ahead window (days)
            </label>
            <input id="win" type="number" min={7} max={60} value={form.windowDays} onChange={(e) => setForm({ ...form, windowDays: Number(e.target.value) })} className={inputCls} />
            <p className="mt-1 text-xs text-muted">The brief specifies 30 days.</p>
          </div>
          <label className="flex cursor-pointer items-start gap-3 self-end rounded-lg border border-line-strong px-3 py-2.5">
            <input type="checkbox" checked={form.weeklyEnabled} onChange={(e) => setForm({ ...form, weeklyEnabled: e.target.checked })} className="mt-0.5 size-4 accent-cyan" />
            <span className="text-sm">
              Send the weekly digest
              {nextRunLabel && (
                <span className="mt-0.5 block text-xs text-muted">
                  Next: {nextRunLabel}
                  {nextRunWindow ? ` (Vercel Hobby may run it any time ${nextRunWindow})` : ""}
                </span>
              )}
            </span>
          </label>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" icon={Save} busy={busy}>
          Save settings
        </Button>
        <div aria-live="polite" className="text-sm">
          {result && (
            <span className={`inline-flex items-center gap-1.5 ${result.ok ? "text-lime" : "text-rose"}`}>
              {result.ok ? <CircleCheck className="size-4" aria-hidden="true" /> : <TriangleAlert className="size-4" aria-hidden="true" />}
              {result.message}
            </span>
          )}
        </div>
      </div>
    </form>
  );
}
