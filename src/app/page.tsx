import Link from "next/link";
import {
  ArrowRight,
  BellRing,
  Brain,
  CalendarClock,
  Database,
  Link2,
  Mail,
  Radar,
  ShieldCheck,
  Workflow,
  Cog,
} from "lucide-react";
import { isAdminServer } from "@/lib/auth/server";

const STAGES = [
  { icon: CalendarClock, name: "Trigger", text: "Vercel Cron starts the run every Monday morning. Manual runs are protected." },
  { icon: Radar, name: "Input", text: "Tavily live search plus public event pages and schema.org markup, within each site's rules." },
  { icon: Database, name: "Context", text: "Neon stores your focus areas, cities, timezone, event history and run records." },
  { icon: Cog, name: "Processing", text: "Normalise, de-duplicate, apply the 30-day window and compute deadline urgency in code." },
  { icon: Brain, name: "AI / Gemini Flash", text: "Scores relevance and writes short, source-grounded summaries. Nothing is invented." },
  { icon: Mail, name: "Output", text: "A ranked Resend digest, stored records and a dashboard with run history." },
];

const RULES = [
  { icon: CalendarClock, title: "30-day window", text: "Only upcoming events that have not ended and start inside the window." },
  { icon: BellRing, title: "Under 7 days = flagged", text: "A known registration deadline fewer than 7 days away is clearly flagged. Unknown stays unknown." },
  { icon: Link2, title: "Source traceability", text: "Every event keeps its original links. Missing facts are shown as unavailable, never guessed." },
  { icon: ShieldCheck, title: "Reliable delivery", text: "Failures are logged and a retried Monday run can never send a second digest." },
];

export default async function Home() {
  const signedIn = await isAdminServer();
  return (
    <div className="flex flex-1 flex-col">
      <header className="relative z-20 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg border border-line-strong bg-surface-2 text-cyan">
            <Radar className="size-4" aria-hidden="true" />
          </span>
          <span className="text-sm font-semibold tracking-tight">Industry Event Scout</span>
        </div>
        <Link href="/dashboard" className="rounded-lg border border-line-strong bg-surface/70 px-3.5 py-2 text-sm font-medium backdrop-blur transition hover:border-cyan/60">
          {signedIn ? "Open dashboard" : "Sign in"}
        </Link>
      </header>

      <section className="relative isolate -mt-[72px] min-h-[640px] overflow-hidden pt-[72px]">
        <div className="relative z-10 mx-auto flex min-h-[560px] max-w-6xl flex-col justify-center px-5 py-20">
          <p className="mb-4 inline-flex w-fit items-center gap-2 rounded-full border border-line-strong bg-surface/70 px-3 py-1 text-xs font-medium text-muted backdrop-blur">
            <span className="size-1.5 rounded-full bg-lime" aria-hidden="true" />
            Live data · Weekly email · Gemini Flash
          </p>
          <h1 className="max-w-3xl text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Never find out about the right room the day after registration closes.
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-muted">
            Industry Event Scout searches the web every week for conferences, roundtables and CXO meetups in your domains and cities, ranks them against your focus
            areas, and emails a digest you can scan in under five minutes - with closing deadlines flagged.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/dashboard" className="inline-flex items-center gap-2 rounded-lg bg-cyan px-5 py-3 text-sm font-semibold text-bg transition hover:brightness-110">
              Open the dashboard <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
            <a href="#how-it-works" className="rounded-lg border border-line-strong bg-surface/70 px-5 py-3 text-sm font-medium backdrop-blur transition hover:border-line-strong hover:bg-surface-2">
              How it works
            </a>
          </div>
          <p className="mt-6 max-w-xl text-xs leading-relaxed text-faint">
            Coverage is broad but not exhaustive: private newsletters and login-walled posts are out of reach, and details a source does not publish are shown as unavailable.
          </p>
        </div>
      </section>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-20">
        <section id="how-it-works" className="scroll-mt-8 py-14">
          <div className="mb-8 flex items-end justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-cyan">Architecture</p>
              <h2 className="mt-2 flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <Workflow className="size-6 text-muted" aria-hidden="true" /> Trigger → Input → Context → Processing → AI → Output
              </h2>
            </div>
          </div>
          <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STAGES.map((s, i) => (
              <li key={s.name} className="rounded-xl border border-line bg-surface p-5">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 place-items-center rounded-lg bg-surface-3 text-cyan">
                    <s.icon className="size-4.5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="font-mono text-[11px] text-faint">STEP {i + 1} OF 6</p>
                    <h3 className="font-semibold">{s.name}</h3>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="py-6">
          <h2 className="mb-6 text-2xl font-semibold tracking-tight">Rules the system will not break</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {RULES.map((r) => (
              <li key={r.title} className="flex gap-4 rounded-xl border border-line bg-surface p-5">
                <r.icon className="mt-0.5 size-5 shrink-0 text-lime" aria-hidden="true" />
                <div>
                  <h3 className="font-semibold">{r.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{r.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-line px-5 py-6 text-center text-xs text-faint">
        Scores are AI decision support, not guarantees. You decide what to attend. Built for the Mesa C4 &ldquo;AI and its Applications&rdquo; examination.
      </footer>
    </div>
  );
}
