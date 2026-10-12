import { LIMITS } from "@/lib/config";
import type { JsonLdEvent } from "@/lib/input/jsonld";
import { errorMessage } from "@/lib/log";
import type { RetrievalMethod } from "@/lib/types";
import { toGeminiSchema, type LlmClient } from "./llm";
import { neutralize, EXTRACTION_SYSTEM } from "./prompts";
import { extractEnvelopeSchema, extractItemSchema, type ExtractItem } from "./schemas";

/** Everything known about one retrieved page; the unit of work for extraction. */
export interface PageEvidence {
  /** Short stable id used inside prompts ("p1"). */
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  title: string;
  snippet: string;
  text: string;
  jsonLd: JsonLdEvent[];
  retrievalMethod: RetrievalMethod;
  httpStatus: number | null;
  retrievedAt: string;
  query: string;
}

export interface ExtractionOutcome {
  items: Map<string, ExtractItem>;
  /** Page ids Gemini failed to return a valid result for. */
  missing: string[];
  calls: number;
  errors: string[];
}

function renderPage(p: PageEvidence): string {
  const structured = p.jsonLd.length
    ? `<structured_data>\n${neutralize(p.jsonLd.slice(0, 3).map((e) => e.raw).join("\n")).slice(0, 1500)}\n</structured_data>\n`
    : "";
  return `### PAGE ${p.id}
url: ${p.url}
search_title: ${neutralize(p.title).slice(0, 200)}
${structured}<source_text>
${neutralize(p.text).slice(0, LIMITS.pageTextMaxChars)}
</source_text>`;
}

const schema = toGeminiSchema(extractEnvelopeSchema);

/**
 * Batched structured extraction. Output is validated item-by-item with Zod; anything
 * malformed is reported as missing (and later treated as "no event"), never repaired.
 */
export async function extractFromPages(
  llm: LlmClient,
  pages: PageEvidence[],
  ctx: { today: string; timezone: string; deadline?: number },
): Promise<ExtractionOutcome> {
  const outcome: ExtractionOutcome = { items: new Map(), missing: [], calls: 0, errors: [] };
  const batches: PageEvidence[][] = [];
  for (let i = 0; i < pages.length; i += LIMITS.extractBatchSize) batches.push(pages.slice(i, i + LIMITS.extractBatchSize));

  for (const batch of batches) {
    if (ctx.deadline && Date.now() > ctx.deadline) {
      outcome.missing.push(...batch.map((p) => p.id));
      outcome.errors.push("Skipped extraction batch: run time budget exhausted.");
      continue;
    }
    const wanted = new Set(batch.map((p) => p.id));
    outcome.calls += 1;
    try {
      const raw = await llm.generateJson({
        label: "extract",
        system: EXTRACTION_SYSTEM,
        jsonSchema: schema,
        prompt: `Today's date is ${ctx.today} (timezone ${ctx.timezone}).\nExtract events from these ${batch.length} pages.\n\n${batch.map(renderPage).join("\n\n")}`,
      });
      const results = (raw as { results?: unknown })?.results;
      if (!Array.isArray(results)) throw new Error("Response had no results array.");
      for (const entry of results) {
        const parsed = extractItemSchema.safeParse(entry);
        if (parsed.success && wanted.has(parsed.data.id) && !outcome.items.has(parsed.data.id)) {
          outcome.items.set(parsed.data.id, parsed.data);
        }
      }
    } catch (err) {
      outcome.errors.push(errorMessage(err));
    }
    for (const id of wanted) if (!outcome.items.has(id)) outcome.missing.push(id);
  }
  return outcome;
}
