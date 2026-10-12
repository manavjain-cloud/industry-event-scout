import { CircleCheck, CircleDashed } from "lucide-react";

const ITEMS: Array<{ key: string; label: string; vars: string; where: string }> = [
  { key: "database", label: "Neon PostgreSQL", vars: "DATABASE_URL", where: "Neon console → Connection details (pooled string), then run `npm run db:setup`." },
  { key: "tavily", label: "Tavily live search", vars: "TAVILY_API_KEY", where: "app.tavily.com → API Keys." },
  { key: "gemini", label: "Gemini Flash", vars: "GEMINI_API_KEY, GEMINI_MODEL", where: "Google AI Studio → Get API key." },
  { key: "resend", label: "Resend email", vars: "RESEND_API_KEY, RESEND_FROM_EMAIL", where: "resend.com → API Keys. Without a verified domain, Resend only delivers to your own account email." },
  { key: "cron", label: "Cron protection", vars: "CRON_SECRET", where: "Any random string of 16+ characters; set it in Vercel too." },
];

/** Shows which integrations are configured. Names only - values never reach the browser. */
export function SetupPanel({ integrations, dbError }: { integrations: Record<string, boolean>; dbError: string | null }) {
  const missing = ITEMS.filter((i) => !integrations[i.key]);
  if (missing.length === 0 && !dbError) return null;
  return (
    <section aria-labelledby="setup-h" className="mb-6 rounded-xl border border-amber/40 bg-amber/5 p-5">
      <h2 id="setup-h" className="text-base font-semibold text-amber">
        Setup incomplete
      </h2>
      <p className="mt-1 text-sm text-muted">
        The dashboard works with whatever is configured; each missing item only disables the stage that needs it. Set values in <code className="font-mono">.env.local</code> (local) or Vercel
        Environment Variables (deployed).
      </p>
      {dbError && <p className="mt-3 rounded-lg border border-rose/40 bg-rose-bg px-3 py-2 text-sm text-rose">Database: {dbError}</p>}
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {ITEMS.map((i) => {
          const ok = integrations[i.key];
          return (
            <li key={i.key} className="flex gap-3 rounded-lg border border-line bg-surface p-3 text-sm">
              {ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-lime" aria-hidden="true" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden="true" />}
              <div>
                <p className="font-medium">
                  {i.label} <span className="font-normal text-faint">{ok ? "· configured" : "· not configured"}</span>
                </p>
                {!ok && (
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">
                    <code className="font-mono text-cyan">{i.vars}</code> - {i.where}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
