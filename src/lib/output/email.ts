import { URGENT_DEADLINE_DAYS } from "@/lib/config";
import { formatDate } from "@/lib/dates/tz";
import { validateHttpUrl } from "@/lib/processing/urls";
import type { Preferences } from "@/lib/types";
import type { Digest, DigestItem } from "./digest";

/** HTML escape: every event field originates from the open web and is untrusted. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const UNAVAILABLE = "Not published / unavailable";

function dateLine(item: DigestItem): string {
  const e = item.event;
  const start = formatDate(e.startsOn, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const range = e.endsOn && e.endsOn !== e.startsOn ? `${start} - ${formatDate(e.endsOn, { day: "numeric", month: "short", year: "numeric" })}` : start;
  return `${range}${item.ongoing ? " (ongoing)" : ""}${e.timeText ? `, ${e.timeText}` : ""}`;
}

function placeLine(item: DigestItem): string {
  const { city, venue } = item.event;
  return `${city ?? "City unavailable"} · ${venue ?? "Venue unavailable"}`;
}

function deadlineLine(item: DigestItem): string {
  const e = item.event;
  switch (item.deadline.status) {
    case "urgent":
      return `${item.deadline.label.toUpperCase()} (${formatDate(e.registrationDeadline ?? e.registrationDeadlineAt?.slice(0, 10) ?? "")})`;
    case "upcoming":
      return `${formatDate(e.registrationDeadline ?? e.registrationDeadlineAt?.slice(0, 10) ?? "")} - ${item.deadline.label.toLowerCase()}`;
    case "expired":
      return `${formatDate(e.registrationDeadline ?? e.registrationDeadlineAt?.slice(0, 10) ?? "")} - passed, registration may be closed`;
    default:
      return `Registration deadline: ${UNAVAILABLE.toLowerCase()} - check the event page`;
  }
}

function links(item: DigestItem): Array<{ label: string; url: string }> {
  const e = item.event;
  const out: Array<{ label: string; url: string }> = [];
  const reg = validateHttpUrl(e.registrationUrl);
  if (reg) out.push({ label: "Register", url: reg });
  const source = e.sources.map((s) => validateHttpUrl(s.url)).find(Boolean);
  if (source && source !== reg) out.push({ label: reg ? "Original source" : "Event page", url: source });
  return out;
}

function alsoListed(item: DigestItem): string[] {
  return [...new Set(item.event.sources.map((s) => s.domain))].slice(0, 4);
}

const C = {
  ink: "#0f172a",
  muted: "#475569",
  line: "#e2e8f0",
  bg: "#f1f5f9",
  card: "#ffffff",
  brand: "#4f46e5",
  warnBg: "#fff1f2",
  warnInk: "#9f1239",
  warnLine: "#e11d48",
  okBg: "#eef2ff",
};

function urgentBadge(item: DigestItem): string {
  return `<div style="margin:10px 0 0;padding:8px 10px;background:${C.warnBg};border:2px solid ${C.warnLine};border-radius:6px;color:${C.warnInk};font-weight:700;font-size:13px;line-height:1.4">&#9888; ${esc(deadlineLine(item))}</div>`;
}

function card(item: DigestItem): string {
  const e = item.event;
  const score = e.relevanceScore === null ? "" : `<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;background:${C.okBg};color:${C.brand};font-size:12px;font-weight:700;white-space:nowrap">Match ${e.relevanceScore}/100</span>`;
  const title = links(item)[0]
    ? `<a href="${esc(links(item).at(-1)!.url)}" style="color:${C.ink};text-decoration:none">${esc(e.title)}</a>`
    : esc(e.title);
  const deadlineBlock =
    item.deadline.status === "urgent"
      ? urgentBadge(item)
      : `<div style="margin:8px 0 0;font-size:13px;color:${C.muted}"><strong>Registration:</strong> ${esc(deadlineLine(item))}</div>`;
  const why = e.relevanceReason
    ? `<div style="margin:8px 0 0;font-size:13px;color:${C.muted}"><strong style="color:${C.ink}">Why it matches:</strong> ${esc(e.relevanceReason)}${e.matchedFocusAreas.length ? ` <span style="color:${C.brand}">[${esc(e.matchedFocusAreas.join(", "))}]</span>` : ""}</div>`
    : "";
  const buttons = links(item)
    .map((l, i) =>
      i === 0
        ? `<a href="${esc(l.url)}" style="display:inline-block;margin:12px 8px 0 0;padding:9px 14px;background:${C.brand};color:#ffffff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:700">${esc(l.label)} &rarr;</a>`
        : `<a href="${esc(l.url)}" style="display:inline-block;margin:12px 8px 0 0;padding:8px 13px;border:1px solid ${C.line};color:${C.ink};text-decoration:none;border-radius:6px;font-size:13px">${esc(l.label)}</a>`,
    )
    .join("");
  const also = alsoListed(item);
  return `<tr><td style="padding:0 0 14px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.card};border:1px solid ${item.deadline.status === "urgent" ? C.warnLine : C.line};border-radius:10px"><tr><td style="padding:16px 18px">
<div style="font-size:12px;color:${C.muted};font-weight:700;letter-spacing:.04em">#${item.rank}${score}</div>
<div style="margin:6px 0 0;font-size:18px;line-height:1.3;font-weight:700;color:${C.ink}">${title}</div>
<div style="margin:6px 0 0;font-size:14px;color:${C.ink}"><strong>${esc(dateLine(item))}</strong></div>
<div style="margin:2px 0 0;font-size:13px;color:${C.muted}">${esc(placeLine(item))}</div>
${deadlineBlock}
${e.summary ? `<div style="margin:10px 0 0;font-size:14px;line-height:1.5;color:${C.ink}">${esc(e.summary)}</div>` : ""}
${why}
<div>${buttons}</div>
${also.length ? `<div style="margin:10px 0 0;font-size:11px;color:${C.muted}">Found on: ${esc(also.join(", "))}</div>` : ""}
</td></tr></table></td></tr>`;
}

export function renderDigestHtml(digest: Digest, prefs: Preferences, appUrl?: string): string {
  const testBanner = digest.isTest
    ? `<tr><td style="padding:0 0 14px"><div style="padding:10px 14px;background:#fef9c3;border:1px solid #facc15;border-radius:8px;color:#713f12;font-size:13px;font-weight:700">TEST SEND - triggered manually from the dashboard. This is not the scheduled weekly digest.</div></td></tr>`
    : "";
  const urgentBlock = digest.urgent.length
    ? `<tr><td style="padding:0 0 14px"><div style="padding:14px 16px;background:${C.warnBg};border:2px solid ${C.warnLine};border-radius:10px">
<div style="font-size:14px;font-weight:800;color:${C.warnInk}">&#9888; Act now: registration closes in fewer than ${URGENT_DEADLINE_DAYS} days</div>
${digest.urgent.map((i) => `<div style="margin:8px 0 0;font-size:13px;color:${C.ink}"><strong>${esc(i.event.title)}</strong> - ${esc(deadlineLine(i))}${links(i)[0] ? ` &middot; <a href="${esc(links(i)[0].url)}" style="color:${C.brand}">${esc(links(i)[0].label)}</a>` : ""}</div>`).join("")}
</div></td></tr>`
    : "";
  const notes = digest.notes.length
    ? `<tr><td style="padding:0 0 14px;font-size:12px;color:${C.muted}">${digest.notes.map((n) => `&bull; ${esc(n)}`).join("<br>")}</td></tr>`
    : "";
  const body =
    digest.items.length > 0
      ? digest.items.map(card).join("\n")
      : `<tr><td style="padding:18px;background:${C.card};border:1px dashed ${C.line};border-radius:10px;font-size:14px;color:${C.muted}">No matching events were found for your configured search. No events have been invented to fill this list.</td></tr>`;
  const dashboard = appUrl ? `<a href="${esc(appUrl)}" style="color:${C.brand}">Open dashboard</a> &middot; ` : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(digest.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center" style="padding:20px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px">
<tr><td style="padding:0 0 14px"><div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:${C.brand}">INDUSTRY EVENT SCOUT</div>
<div style="margin:4px 0 0;font-size:24px;font-weight:800;color:${C.ink};line-height:1.2">Events for ${esc(digest.windowLabel)}</div>
<div style="margin:6px 0 0;font-size:14px;line-height:1.5;color:${C.muted}">${esc(digest.intro)}</div>
<div style="margin:6px 0 0;font-size:12px;color:${C.muted}">About a ${esc(digest.readMinutes)}-minute read &middot; Cities: ${esc(prefs.cities.join(", "))}</div></td></tr>
${testBanner}${urgentBlock}${notes}
${body}
<tr><td style="padding:10px 0 0;font-size:11px;line-height:1.5;color:${C.muted}">${dashboard}Scores and summaries are AI-generated decision support from public web pages; dates, venues and deadlines are shown only when a source states them, and may change. Always confirm on the original source before registering. You decide whether to attend.</td></tr>
</table></td></tr></table></body></html>`;
}

export function renderDigestText(digest: Digest, prefs: Preferences, appUrl?: string): string {
  const lines: string[] = [];
  if (digest.isTest) lines.push("*** TEST SEND - triggered manually from the dashboard; not the scheduled weekly digest ***", "");
  lines.push("INDUSTRY EVENT SCOUT", `Events for ${digest.windowLabel}`, digest.intro, `About a ${digest.readMinutes}-minute read. Cities: ${prefs.cities.join(", ")}`, "");
  if (digest.urgent.length) {
    lines.push(`!! ACT NOW - registration closes in fewer than ${URGENT_DEADLINE_DAYS} days:`);
    for (const i of digest.urgent) lines.push(`  - ${i.event.title}: ${deadlineLine(i)}${links(i)[0] ? ` -> ${links(i)[0].url}` : ""}`);
    lines.push("");
  }
  for (const n of digest.notes) lines.push(`Note: ${n}`);
  if (digest.notes.length) lines.push("");
  if (digest.items.length === 0) lines.push("No matching events were found for your configured search. No events have been invented to fill this list.", "");
  for (const i of digest.items) {
    const e = i.event;
    lines.push(`#${i.rank} ${e.title}${e.relevanceScore === null ? "" : `  [Match ${e.relevanceScore}/100]`}`);
    lines.push(`   When: ${dateLine(i)}`, `   Where: ${placeLine(i)}`);
    lines.push(`   ${i.deadline.status === "urgent" ? "!! " : ""}Registration: ${deadlineLine(i)}`);
    if (e.summary) lines.push(`   ${e.summary}`);
    if (e.relevanceReason) lines.push(`   Why it matches: ${e.relevanceReason}`);
    for (const l of links(i)) lines.push(`   ${l.label}: ${l.url}`);
    lines.push("");
  }
  if (appUrl) lines.push(`Dashboard: ${appUrl}`);
  lines.push("Scores and summaries are AI-generated decision support from public web pages. Confirm details on the original source before registering. You decide whether to attend.");
  return lines.join("\n");
}
