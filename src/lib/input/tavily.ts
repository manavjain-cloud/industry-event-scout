import { z } from "zod";
import { LIMITS } from "@/lib/config";
import { errorMessage } from "@/lib/log";
import { domainOf, isLikelyEventSource, normalizeUrl, validateHttpUrl } from "@/lib/processing/urls";
import type { SearchQuery } from "./queries";

export type FetchLike = typeof fetch;

export interface SearchHit {
  title: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  snippet: string;
  rawContent: string | null;
  score: number;
  query: string;
}

export class SearchProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "quota" | "rate_limit" | "server" | "network" | "bad_response",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

const responseSchema = z.object({
  results: z
    .array(
      z.object({
        title: z.string().optional().default(""),
        url: z.string(),
        content: z.string().optional().default(""),
        score: z.number().optional().default(0),
        raw_content: z.string().nullish(),
      }),
    )
    .default([]),
  usage: z.object({ credits: z.number().optional() }).partial().nullish(),
});

const ENDPOINT = "https://api.tavily.com/search";
const RAW_CONTENT_CAP = 20_000;

export interface TavilyClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface SingleSearchResult {
  hits: SearchHit[];
  credits: number;
}

/** One Tavily search (basic depth = 1 credit). Throws SearchProviderError with a precise kind. */
export async function tavilySearch(query: SearchQuery, opts: TavilyClientOptions): Promise<SingleSearchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        query: query.text,
        search_depth: "basic",
        topic: "general",
        max_results: LIMITS.resultsPerQuery,
        include_raw_content: "markdown",
        include_usage: true,
        ...(query.includeDomains ? { include_domains: query.includeDomains } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
  } catch (err) {
    throw new SearchProviderError(`Tavily request failed: ${errorMessage(err)}`, "network");
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 401) throw new SearchProviderError("Tavily rejected the API key (401). Check TAVILY_API_KEY.", "auth", status);
    if (status === 432 || status === 433) throw new SearchProviderError("Tavily plan/usage limit exceeded.", "quota", status);
    if (status === 429) throw new SearchProviderError("Tavily rate limit reached (429).", "rate_limit", status);
    throw new SearchProviderError(`Tavily returned HTTP ${status}.`, status >= 500 ? "server" : "bad_response", status);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new SearchProviderError("Tavily returned a non-JSON response.", "bad_response", response.status);
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) throw new SearchProviderError("Tavily response did not match the expected shape.", "bad_response");

  const hits: SearchHit[] = [];
  for (const r of parsed.data.results) {
    const url = validateHttpUrl(r.url);
    const normalizedUrl = url ? normalizeUrl(url) : null;
    if (!url || !normalizedUrl || !isLikelyEventSource(url)) continue;
    hits.push({
      title: r.title.trim(),
      url,
      normalizedUrl,
      domain: domainOf(url),
      snippet: r.content.trim(),
      rawContent: r.raw_content ? r.raw_content.slice(0, RAW_CONTENT_CAP) : null,
      score: r.score,
      query: query.text,
    });
  }
  return { hits, credits: parsed.data.usage?.credits ?? 1 };
}

export interface SearchRunResult {
  hits: SearchHit[];
  failures: Array<{ queryId: string; message: string; kind: SearchProviderError["kind"] | "unknown" }>;
  succeeded: number;
  credits: number;
}

async function pool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await worker(items[i]);
      }
    }),
  );
  return out;
}

export { pool };

/**
 * Runs the planned queries with bounded concurrency. A failing query never aborts the
 * rest, and failures are reported (never replaced by fabricated results). After an
 * auth or quota error the remaining queries are skipped to avoid wasting credits.
 */
export async function runSearches(
  queries: SearchQuery[],
  opts: TavilyClientOptions & { concurrency?: number; deadline?: number },
): Promise<SearchRunResult> {
  const result: SearchRunResult = { hits: [], failures: [], succeeded: 0, credits: 0 };
  let fatal = false;

  await pool(queries, opts.concurrency ?? LIMITS.searchConcurrency, async (q) => {
    if (fatal) {
      result.failures.push({ queryId: q.id, message: "Skipped after a fatal Tavily error.", kind: "unknown" });
      return;
    }
    if (opts.deadline && Date.now() > opts.deadline) {
      result.failures.push({ queryId: q.id, message: "Skipped: run time budget exhausted.", kind: "unknown" });
      return;
    }
    try {
      const r = await tavilySearch(q, opts);
      result.hits.push(...r.hits);
      result.credits += r.credits;
      result.succeeded += 1;
    } catch (err) {
      const kind = err instanceof SearchProviderError ? err.kind : "unknown";
      if (kind === "auth" || kind === "quota") fatal = true;
      result.failures.push({ queryId: q.id, message: errorMessage(err), kind });
    }
  });

  return result;
}

/** De-duplicate hits by normalized URL, keeping the richest copy and the best score. */
export function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const byUrl = new Map<string, SearchHit>();
  for (const h of hits) {
    const existing = byUrl.get(h.normalizedUrl);
    if (!existing) {
      byUrl.set(h.normalizedUrl, h);
      continue;
    }
    byUrl.set(h.normalizedUrl, {
      ...existing,
      score: Math.max(existing.score, h.score),
      rawContent: (existing.rawContent?.length ?? 0) >= (h.rawContent?.length ?? 0) ? existing.rawContent : h.rawContent,
      snippet: existing.snippet.length >= h.snippet.length ? existing.snippet : h.snippet,
    });
  }
  return [...byUrl.values()].sort((a, b) => b.score - a.score);
}
