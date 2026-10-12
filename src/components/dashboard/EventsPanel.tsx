"use client";

import { CalendarSearch, RefreshCw, Search, SearchX, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { DashboardEvent } from "@/lib/dashboard-data";
import { canonicalCity } from "@/lib/processing/normalize";
import { EventCard } from "./EventCard";
import { Button, EmptyState } from "./ui";

type SortKey = "relevance" | "date" | "deadline";

const selectCls = "rounded-lg border border-line-strong bg-bg px-3 py-2 text-sm outline-none focus:border-cyan";

export function EventsPanel({
  events,
  focusAreas,
  excludedNote,
  onRefresh,
  refreshing,
}: {
  events: DashboardEvent[];
  focusAreas: string[];
  excludedNote: string | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("all");
  const [focus, setFocus] = useState("all");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [urgentOnly, setUrgentOnly] = useState(false);

  const cities = useMemo(() => [...new Set(events.map((e) => canonicalCity(e.city)).filter((c): c is string => !!c))].sort(), [events]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = events.filter((e) => {
      if (urgentOnly && e.deadline.status !== "urgent") return false;
      if (city !== "all" && canonicalCity(e.city) !== city) return false;
      if (focus !== "all" && !e.matchedFocusAreas.includes(focus)) return false;
      if (q && !`${e.title} ${e.venue ?? ""} ${e.summary ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sort === "date") return a.startsOn.localeCompare(b.startsOn) || (b.score ?? -1) - (a.score ?? -1);
      if (sort === "deadline") {
        const da = a.deadline.status === "urgent" || a.deadline.status === "upcoming" ? (a.deadline.daysRemaining ?? 999) : 9999;
        const db = b.deadline.status === "urgent" || b.deadline.status === "upcoming" ? (b.deadline.daysRemaining ?? 999) : 9999;
        return da - db || a.startsOn.localeCompare(b.startsOn);
      }
      return (b.score ?? -1) - (a.score ?? -1) || a.startsOn.localeCompare(b.startsOn);
    });
  }, [events, query, city, focus, sort, urgentOnly]);

  const filtersActive = query !== "" || city !== "all" || focus !== "all" || urgentOnly;
  const clear = () => {
    setQuery("");
    setCity("all");
    setFocus("all");
    setUrgentOnly(false);
  };

  if (events.length === 0) {
    return (
      <EmptyState
        icon={CalendarSearch}
        title="No events in the next window yet"
        action={
          <Button variant="primary" icon={RefreshCw} onClick={onRefresh} busy={refreshing}>
            Run discovery now
          </Button>
        }
      >
        Nothing has been collected for your current focus areas and cities. Run a discovery to search the web live, or check the settings. No events are ever made up to fill this
        list.
      </EmptyState>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2" role="search" aria-label="Filter events">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search title, venue, summary"
            aria-label="Search events"
            className={`${selectCls} w-full pl-9`}
          />
        </div>
        <select aria-label="Filter by city" value={city} onChange={(e) => setCity(e.target.value)} className={selectCls}>
          <option value="all">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select aria-label="Filter by focus area" value={focus} onChange={(e) => setFocus(e.target.value)} className={selectCls}>
          <option value="all">All categories</option>
          {focusAreas.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select aria-label="Sort events" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className={selectCls}>
          <option value="relevance">Sort: relevance</option>
          <option value="date">Sort: event date</option>
          <option value="deadline">Sort: closing soonest</option>
        </select>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-sm">
          <input type="checkbox" checked={urgentOnly} onChange={(e) => setUrgentOnly(e.target.checked)} className="size-4 accent-rose" />
          Closing in &lt; 7 days
        </label>
        {filtersActive && (
          <Button variant="ghost" icon={X} onClick={clear}>
            Clear
          </Button>
        )}
      </div>

      <p className="mb-3 text-xs text-faint" aria-live="polite">
        Showing {visible.length} of {events.length} events.{excludedNote ? ` ${excludedNote}` : ""}
      </p>

      {visible.length === 0 ? (
        <EmptyState icon={SearchX} title="No events match these filters" action={<Button onClick={clear}>Clear filters</Button>} />
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {visible.map((e, i) => (
            <li key={e.id}>
              <EventCard event={e} rank={sort === "relevance" ? i + 1 : undefined} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
