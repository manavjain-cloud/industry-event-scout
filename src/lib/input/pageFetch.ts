import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LIMITS } from "@/lib/config";
import { errorMessage } from "@/lib/log";
import { canFetchDirectly, validateHttpUrl } from "@/lib/processing/urls";
import type { FetchLike } from "./tavily";

export const USER_AGENT = "IndustryEventScoutBot/1.0 (+personal event digest; respects robots.txt)";

export type PageFetchOutcome =
  | { ok: true; url: string; finalUrl: string; status: number; html: string }
  | { ok: false; url: string; reason: "blocked_domain" | "invalid_url" | "private_address" | "robots_disallowed" | "robots_unavailable" | "http_error" | "not_html" | "too_large" | "timeout" | "network" | "too_many_redirects"; status?: number; message: string };

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80") || s.startsWith("ff")) return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not an IP: caller must resolve first
}

export type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true })).map((r) => r.address);

/** True when every address the hostname resolves to is public. */
export async function resolvesToPublicAddress(hostname: string, resolver: Resolver = defaultResolver): Promise<boolean> {
  if (isIP(hostname)) return !isPrivateIp(hostname);
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(hostname)) return false;
  try {
    const addrs = await resolver(hostname);
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a));
  } catch {
    return false;
  }
}

export interface RobotsRules {
  allow: string[];
  disallow: string[];
}

export type RobotsCache = Map<string, Promise<RobotsRules | "unavailable">>;

/** Minimal robots.txt evaluation: group for our agent (else "*"), longest matching rule wins, Allow beats Disallow on ties. */
export function parseRobots(text: string, agent = "industryeventscoutbot"): RobotsRules {
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[] }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current) continue;
      if (key === "allow" && value) current.allow.push(value);
      if (key === "disallow" && value) current.disallow.push(value);
    }
  }
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const star = groups.find((g) => g.agents.includes("*"));
  const chosen = specific ?? star;
  return { allow: chosen?.allow ?? [], disallow: chosen?.disallow ?? [] };
}

function ruleToRegex(rule: string): RegExp {
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped.endsWith("\\$") ? escaped.slice(0, -2) + "$" : escaped}`);
}

export function robotsAllows(rules: RobotsRules, pathAndQuery: string): boolean {
  let best: { len: number; allow: boolean } | null = null;
  for (const [list, allow] of [[rules.disallow, false], [rules.allow, true]] as const) {
    for (const rule of list) {
      if (ruleToRegex(rule).test(pathAndQuery) && (!best || rule.length > best.len || (rule.length === best.len && allow))) {
        best = { len: rule.length, allow };
      }
    }
  }
  return best ? best.allow : true;
}

export interface PageFetchDeps {
  fetchImpl?: FetchLike;
  resolver?: Resolver;
  /** Per-run cache so robots.txt is fetched once per origin. */
  robotsCache?: RobotsCache;
}

async function loadRobots(origin: string, deps: PageFetchDeps): Promise<RobotsRules | "unavailable"> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/plain" },
      signal: AbortSignal.timeout(4_000),
      redirect: "follow",
    });
    if (res.status >= 500) return "unavailable";
    if (!res.ok) return { allow: [], disallow: [] }; // no robots.txt (4xx) => no restrictions
    return parseRobots((await res.text()).slice(0, 200_000));
  } catch {
    return "unavailable";
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), truncated };
}

/**
 * Retrieve one public event page. Policy: only http(s); never login-walled platforms;
 * never private/internal addresses (SSRF), re-checked on every redirect hop; honour
 * robots.txt; hard timeout and size cap; HTML only.
 */
export async function fetchPublicPage(rawUrl: string, deps: PageFetchDeps = {}): Promise<PageFetchOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const cache = deps.robotsCache ?? new Map();
  const validated = validateHttpUrl(rawUrl);
  if (!validated) return { ok: false, url: rawUrl, reason: "invalid_url", message: "Not a valid http(s) URL." };
  let current: string = validated;
  if (!canFetchDirectly(current)) {
    return { ok: false, url: rawUrl, reason: "blocked_domain", message: "Platform requires login; not fetched directly." };
  }

  try {
    for (let hop = 0; hop <= 3; hop++) {
      const u = new URL(current);
      if (!(await resolvesToPublicAddress(u.hostname, deps.resolver))) {
        return { ok: false, url: rawUrl, reason: "private_address", message: "Host resolves to a non-public address." };
      }
      if (!canFetchDirectly(current)) {
        return { ok: false, url: rawUrl, reason: "blocked_domain", message: "Redirected to a login-walled platform." };
      }

      let robotsPromise = cache.get(u.origin);
      if (!robotsPromise) {
        robotsPromise = loadRobots(u.origin, deps);
        cache.set(u.origin, robotsPromise);
      }
      const robots = await robotsPromise;
      if (robots === "unavailable") {
        return { ok: false, url: rawUrl, reason: "robots_unavailable", message: "robots.txt could not be read; not fetched." };
      }
      if (!robotsAllows(robots, u.pathname + u.search)) {
        return { ok: false, url: rawUrl, reason: "robots_disallowed", message: "Disallowed by robots.txt." };
      }

      const res = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml;q=0.9", "Accept-Language": "en" },
        signal: AbortSignal.timeout(LIMITS.pageFetchTimeoutMs),
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        const next = location ? validateHttpUrl(new URL(location, current).toString()) : null;
        if (!next) return { ok: false, url: rawUrl, reason: "http_error", status: res.status, message: "Bad redirect." };
        current = next;
        continue;
      }
      if (!res.ok) {
        return { ok: false, url: rawUrl, reason: "http_error", status: res.status, message: `HTTP ${res.status}` };
      }
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
        return { ok: false, url: rawUrl, reason: "not_html", status: res.status, message: `Unsupported content type: ${type || "unknown"}` };
      }
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > LIMITS.pageMaxBytes * 2) {
        return { ok: false, url: rawUrl, reason: "too_large", status: res.status, message: "Page too large." };
      }
      const { text } = await readCapped(res, LIMITS.pageMaxBytes);
      return { ok: true, url: rawUrl, finalUrl: current, status: res.status, html: text };
    }
    return { ok: false, url: rawUrl, reason: "too_many_redirects", message: "Too many redirects." };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { ok: false, url: rawUrl, reason: timedOut ? "timeout" : "network", message: errorMessage(err) };
  }
}
