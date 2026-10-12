import { isValidIsoDate } from "@/lib/dates/tz";

/**
 * Anti-hallucination guards for AI-extracted facts. Gemini must quote the source text
 * that supports every date/venue/city/deadline; these functions confirm in plain code
 * that the quote really occurs in the retrieved content and actually supports the value.
 */

function squash(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[*_`#>\[\]()|\\]/g, " ")
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if `evidence` occurs verbatim (ignoring case, markdown and whitespace) in `source`. */
export function evidenceInSource(evidence: string | null | undefined, source: string): boolean {
  if (!evidence) return false;
  const needle = squash(evidence);
  if (needle.length < 4) return false;
  return squash(source).includes(needle);
}

const MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may", "may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sep", "sept"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
];

/**
 * Does the quoted evidence actually state this calendar date? Requires the day number
 * and the month (name or number) to appear, and rejects a contradicting year.
 * Relative phrases ("next Friday", "tomorrow") never pass.
 */
export function evidenceSupportsDate(evidence: string, isoDate: string): boolean {
  if (!isValidIsoDate(isoDate)) return false;
  const [y, m, d] = isoDate.split("-").map(Number);
  const text = squash(evidence);

  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((x) => Number(x[1]));
  if (years.length > 0 && !years.includes(y)) return false;

  const dayRe = new RegExp(`(^|[^0-9])0?${d}(st|nd|rd|th)?([^0-9]|$)`);
  const monthNames = MONTHS[m - 1];
  const nameRe = new RegExp(`\\b(${monthNames.join("|")})\\b`);

  if (nameRe.test(text) && dayRe.test(text)) return true;

  // Numeric forms: 2026-10-25, 25/10/2026, 25.10.2026, 25-10-26
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return Number(iso[1]) === y && Number(iso[2]) === m && Number(iso[3]) === d;
  // Day-first numeric dates only (the sources are Indian); an ambiguous month-first reading is rejected.
  for (const mm of text.matchAll(/\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})\b/g)) {
    if (Number(mm[1]) === d && Number(mm[2]) === m) return true;
  }
  return false;
}

/** A registration URL suggested by the model must literally appear in the retrieved content. */
export function urlInSource(url: string | null | undefined, source: string): boolean {
  if (!url) return false;
  const bare = url.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
  return bare.length > 6 && source.toLowerCase().includes(bare);
}
