/** URL validation and normalization (Components Map: PROCESSING). */

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "referrer",
  "source",
  "src",
  "spm",
  "_hsenc",
  "_hsmi",
  "trk",
  "trackingid",
  "aff",
  "affiliate",
]);

/** Domains we never fetch directly (login walls / platform terms). Search snippets may still be used. */
const NO_DIRECT_FETCH = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "t.co",
  "whatsapp.com",
  "youtube.com",
  "youtu.be",
];

/** Domains that are never an event source. */
const NOT_EVENT_SOURCES = ["wikipedia.org", "pinterest.com", "reddit.com", "quora.com", "glassdoor.com", "indeed.com", "naukri.com"];

/** Returns a clean absolute http(s) URL, or null when it cannot be safely shown as a link. */
export function validateHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048 || /[\s<>"'`]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname.includes(".") || url.hostname.endsWith(".")) return null;
  return url.toString();
}

/** Stable identity for a URL: lowercase host without www, no fragment, no tracking params, sorted query. */
export function normalizeUrl(value: string): string | null {
  const valid = validateHttpUrl(value);
  if (!valid) return null;
  const url = new URL(valid);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path;
  url.protocol = "https:";
  url.port = "";
  return url.toString();
}

export function domainOf(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function matchesDomain(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

export function canFetchDirectly(url: string): boolean {
  return !matchesDomain(domainOf(url), NO_DIRECT_FETCH);
}

export function isLikelyEventSource(url: string): boolean {
  return !matchesDomain(domainOf(url), NOT_EVENT_SOURCES);
}
