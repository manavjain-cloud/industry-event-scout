import { CalendarDays, ExternalLink, Info, MapPin, Sparkles } from "lucide-react";
import { formatDate } from "@/lib/dates/tz";
import { cn } from "@/lib/cn";
import { validateHttpUrl } from "@/lib/processing/urls";
import type { DashboardEvent } from "@/lib/dashboard-data";
import { DeadlineBadge } from "./DeadlineBadge";
import { Chip } from "./ui";

const FIELD_LABEL: Record<string, string> = {
  city: "City",
  venue: "Venue",
  registration_url: "Registration link",
  registration_deadline: "Registration deadline",
};

function scoreTone(score: number): string {
  if (score >= 80) return "text-lime";
  if (score >= 60) return "text-cyan";
  if (score >= 40) return "text-amber";
  return "text-faint";
}

export function EventCard({ event, rank }: { event: DashboardEvent; rank?: number }) {
  const start = formatDate(event.startsOn, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const end = event.endsOn && event.endsOn !== event.startsOn ? ` - ${formatDate(event.endsOn, { day: "numeric", month: "short" })}` : "";
  const registrationUrl = validateHttpUrl(event.registrationUrl);
  const sources = event.sources.filter((s) => validateHttpUrl(s.url));
  const primary = sources[0];
  const urgent = event.deadline.status === "urgent";
  const missing = event.missingFields.filter((f) => FIELD_LABEL[f] && f !== "registration_deadline");

  return (
    <article
      aria-label={event.title}
      className={cn("rounded-xl border bg-surface p-5 transition hover:border-line-strong", urgent ? "border-rose/60" : "border-line")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
            {rank !== undefined && <span className="font-mono">#{rank}</span>}
            {event.ongoing && <Chip tone="violet">Ongoing</Chip>}
            {event.format === "hybrid" && <Chip>Hybrid</Chip>}
            {event.belowThreshold && <Chip tone="amber">Below digest threshold</Chip>}
            {event.rankingStale && <Chip tone="amber">Score predates your latest settings</Chip>}
          </div>
          <h3 className="mt-1 text-lg font-semibold leading-snug">
            {primary ? (
              <a href={primary.url} target="_blank" rel="noopener noreferrer" className="hover:text-cyan">
                {event.title}
              </a>
            ) : (
              event.title
            )}
          </h3>
        </div>
        <div className="shrink-0 text-right" aria-label={event.score === null ? "Not ranked" : `Relevance ${event.score} out of 100`}>
          {event.score === null ? (
            <div className="rounded-lg border border-dashed border-line-strong px-2.5 py-1.5 text-xs text-faint">Not ranked</div>
          ) : (
            <>
              <div className={cn("text-3xl font-semibold leading-none tabular-nums", scoreTone(event.score))}>{event.score}</div>
              <div className="mt-1 text-[10px] uppercase tracking-wider text-faint">match / 100</div>
            </>
          )}
        </div>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-sm text-muted sm:grid-cols-2">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Date</dt>
          <CalendarDays className="size-4 shrink-0 text-faint" aria-hidden="true" />
          <dd>
            {start}
            {end}
            {event.timeText ? `, ${event.timeText}` : ""}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="sr-only">Location</dt>
          <MapPin className="size-4 shrink-0 text-faint" aria-hidden="true" />
          <dd>
            {event.city ?? <span className="text-faint">City not stated</span>}
            {" · "}
            {event.venue ?? <span className="text-faint">Venue not confirmed</span>}
          </dd>
        </div>
      </dl>

      <div className="mt-3">
        <DeadlineBadge deadline={event.deadline} date={event.registrationDeadline} />
      </div>

      {event.summary && <p className="mt-3 text-sm leading-relaxed">{event.summary}</p>}
      {event.reason && (
        <p className="mt-2 flex gap-2 text-sm leading-relaxed text-muted">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-violet" aria-hidden="true" />
          <span>
            <span className="font-medium text-ink">Why it matches: </span>
            {event.reason}
          </span>
        </p>
      )}
      {event.matchedFocusAreas.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {event.matchedFocusAreas.map((a) => (
            <Chip key={a} tone="violet">
              {a}
            </Chip>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {registrationUrl && (
          <a
            href={registrationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-cyan px-3.5 py-2 text-sm font-semibold text-bg transition hover:brightness-110"
          >
            Register <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
        {sources.slice(0, 3).map((s, i) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-2 text-sm text-muted transition hover:border-cyan/60 hover:text-ink"
          >
            {i === 0 && !registrationUrl ? "Event page" : "Source"}: {s.domain} <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        ))}
        {sources.length > 3 && <span className="text-xs text-faint">+{sources.length - 3} more sources</span>}
      </div>

      {missing.length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-faint">
          <Info className="size-3.5" aria-hidden="true" />
          Not published by the source: {missing.map((f) => FIELD_LABEL[f]).join(", ").toLowerCase()}.
        </p>
      )}
    </article>
  );
}
