"use client";

import { CircleAlert, CircleCheck, CircleSlash, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  busy,
  icon: Icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean; icon?: LucideIcon }) {
  const styles: Record<Variant, string> = {
    primary: "bg-cyan text-bg font-semibold enabled:hover:brightness-110",
    secondary: "border border-line-strong bg-surface-2 text-ink enabled:hover:border-cyan/60 enabled:hover:bg-surface-3",
    ghost: "text-muted enabled:hover:bg-surface-2 enabled:hover:text-ink",
    danger: "border border-rose/50 bg-rose-bg text-rose enabled:hover:brightness-125",
  };
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : Icon ? <Icon className="size-4" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "cyan" | "violet" | "lime" | "amber" | "rose"; className?: string }) {
  const tones = {
    neutral: "border-line-strong bg-surface-2 text-muted",
    cyan: "border-cyan/40 bg-cyan/10 text-cyan",
    violet: "border-violet/40 bg-violet/10 text-violet",
    lime: "border-lime/40 bg-lime/10 text-lime",
    amber: "border-amber/40 bg-amber/10 text-amber",
    rose: "border-rose/50 bg-rose-bg text-rose",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>;
}

const STATUS: Record<string, { tone: "lime" | "amber" | "rose" | "cyan" | "neutral"; icon: LucideIcon; label: string }> = {
  succeeded: { tone: "lime", icon: CircleCheck, label: "Succeeded" },
  partial: { tone: "amber", icon: TriangleAlert, label: "Partial" },
  failed: { tone: "rose", icon: CircleAlert, label: "Failed" },
  running: { tone: "cyan", icon: LoaderCircle, label: "Running" },
  sent: { tone: "lime", icon: CircleCheck, label: "Email sent" },
  sending: { tone: "cyan", icon: LoaderCircle, label: "Sending" },
  pending: { tone: "neutral", icon: CircleSlash, label: "Email pending" },
  skipped: { tone: "amber", icon: CircleSlash, label: "Email skipped" },
  not_applicable: { tone: "neutral", icon: CircleSlash, label: "No email" },
  ok: { tone: "lime", icon: CircleCheck, label: "OK" },
};

/** Status is always icon + words + colour, never colour alone. */
export function StatusBadge({ status, kind = "run" }: { status: string; kind?: "run" | "email" | "stage" }) {
  const key = kind === "email" && status === "failed" ? "failed" : status;
  const s = STATUS[key] ?? { tone: "neutral" as const, icon: CircleSlash, label: status };
  const label = kind === "email" && status === "failed" ? "Email failed" : kind === "stage" && status === "failed" ? "Failed" : s.label;
  const Icon = s.icon;
  return (
    <Chip tone={s.tone}>
      <Icon className={cn("size-3.5", status === "running" || status === "sending" ? "animate-spin" : "")} aria-hidden="true" />
      {label}
    </Chip>
  );
}

export function StatTile({ label, value, hint, tone = "neutral", icon: Icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "neutral" | "rose" | "cyan"; icon?: LucideIcon }) {
  return (
    <div className={cn("rounded-xl border bg-surface p-4", tone === "rose" ? "border-rose/50" : "border-line")}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted">
        {Icon && <Icon className={cn("size-3.5", tone === "rose" ? "text-rose" : tone === "cyan" ? "text-cyan" : "text-faint")} aria-hidden="true" />}
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs leading-relaxed text-muted">{hint}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-xl border border-dashed border-line-strong bg-surface/60 px-6 py-14 text-center">
      <Icon className="size-8 text-faint" aria-hidden="true" />
      <h3 className="mt-3 text-base font-semibold">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
