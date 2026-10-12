import type { PageEvidence } from "@/lib/ai/extract";
import { LIMITS } from "@/lib/config";
import { parseHtml } from "@/lib/input/html";
import { extractJsonLdEvents } from "@/lib/input/jsonld";
import type { SearchHit } from "@/lib/input/tavily";
import { pool } from "@/lib/input/tavily";
import { canFetchDirectly } from "@/lib/processing/urls";
import type { PipelineDeps } from "./deps";

export interface RetrievalStats {
  evaluated: number;
  direct: number;
  viaTavily: number;
  skippedNoDateSignal: number;
  skippedTooLittleText: number;
  directFailures: Record<string, number>;
}

const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;
const NUMERIC_DATE_RE = /\b(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/;

/** Cheap pre-filter: a page with no date-like text cannot yield a verifiable event, so skip the Gemini spend. */
export function hasDateSignal(text: string): boolean {
  return MONTH_RE.test(text) && /\d/.test(text) ? true : NUMERIC_DATE_RE.test(text);
}

/**
 * Build the evidence for each selected search hit. Preference order:
 *   1. the live page fetched directly (gives JSON-LD + full text) when robots/SSRF policy allows,
 *   2. Tavily's own extracted page content,
 *   3. the search snippet.
 * Retrieval failures are counted by reason; they never abort the run.
 */
export async function retrievePages(
  hits: SearchHit[],
  deps: Pick<PipelineDeps, "fetchPage" | "now">,
  opts: { deadline: number },
): Promise<{ pages: PageEvidence[]; stats: RetrievalStats }> {
  const stats: RetrievalStats = { evaluated: hits.length, direct: 0, viaTavily: 0, skippedNoDateSignal: 0, skippedTooLittleText: 0, directFailures: {} };

  const built = await pool(hits, LIMITS.fetchConcurrency, async (hit, ): Promise<PageEvidence | null> => {
    let text = "";
    let jsonLd: PageEvidence["jsonLd"] = [];
    let title = hit.title;
    let method: PageEvidence["retrievalMethod"] = "snippet";
    let status: number | null = null;
    const retrievedAt = deps.now().toISOString();

    if (canFetchDirectly(hit.url) && Date.now() < opts.deadline) {
      const res = await deps.fetchPage(hit.url);
      if (res.ok) {
        const parsed = parseHtml(res.html);
        jsonLd = extractJsonLdEvents(parsed.jsonLdBlocks);
        text = parsed.text;
        title = parsed.title ?? title;
        method = "direct";
        status = res.status;
        stats.direct += 1;
      } else {
        stats.directFailures[res.reason] = (stats.directFailures[res.reason] ?? 0) + 1;
      }
    }

    if (text.length < 300 && hit.rawContent && hit.rawContent.length > text.length) {
      text = hit.rawContent;
      method = "tavily";
      status = null;
      stats.viaTavily += 1;
    }
    if (text.length < 120) text = [hit.snippet, text].filter(Boolean).join("\n");
    if (text.trim().length < 80 && jsonLd.length === 0) {
      stats.skippedTooLittleText += 1;
      return null;
    }
    if (jsonLd.length === 0 && !hasDateSignal(`${text}\n${hit.snippet}`)) {
      stats.skippedNoDateSignal += 1;
      return null;
    }
    return {
      id: "",
      url: hit.url,
      normalizedUrl: hit.normalizedUrl,
      domain: hit.domain,
      title,
      snippet: hit.snippet,
      text,
      jsonLd,
      retrievalMethod: method,
      httpStatus: status,
      retrievedAt,
      query: hit.query,
    };
  });

  const pages = built.filter((p): p is PageEvidence => p !== null).map((p, i) => ({ ...p, id: `p${i + 1}` }));
  return { pages, stats };
}
