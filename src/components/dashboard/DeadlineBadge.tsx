import { CircleSlash, Clock3, CircleHelp, TriangleAlert } from "lucide-react";
import { formatDate } from "@/lib/dates/tz";
import { cn } from "@/lib/cn";
import type { DeadlineInfo } from "@/lib/types";

/**
 * Deadline states are communicated with icon + text + colour (never colour alone).
 * The status itself is computed in application code (see lib/dates/deadlines.ts).
 */
export function DeadlineBadge({ deadline, date, compact }: { deadline: DeadlineInfo; date: string | null; compact?: boolean }) {
  const dateText = date ? formatDate(date, { day: "numeric", month: "short", year: "numeric" }) : null;
  switch (deadline.status) {
    case "urgent":
      return (
        <div role="status" className={cn("inline-flex items-center gap-2 rounded-lg border-2 border-rose bg-rose-bg font-bold text-rose", compact ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm")}>
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span>
            {deadline.label}
            {dateText && <span className="ml-1 font-medium opacity-90">({dateText})</span>}
          </span>
        </div>
      );
    case "upcoming":
      return (
        <div className={cn("inline-flex items-center gap-2 rounded-lg border border-line-strong bg-surface-2 text-muted", compact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm")}>
          <Clock3 className="size-4 shrink-0" aria-hidden="true" />
          <span>
            {deadline.label}
            {dateText && <span className="ml-1">({dateText})</span>}
          </span>
        </div>
      );
    case "expired":
      return (
        <div className={cn("inline-flex items-center gap-2 rounded-lg border border-amber/40 bg-amber/10 text-amber", compact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm")}>
          <CircleSlash className="size-4 shrink-0" aria-hidden="true" />
          <span>
            Deadline passed{dateText ? ` (${dateText})` : ""} - may be closed
          </span>
        </div>
      );
    default:
      return (
        <div className={cn("inline-flex items-center gap-2 rounded-lg border border-dashed border-line-strong text-faint", compact ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm")}>
          <CircleHelp className="size-4 shrink-0" aria-hidden="true" />
          <span>Deadline not published - check the source</span>
        </div>
      );
  }
}
