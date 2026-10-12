import { LIMITS } from "@/lib/config";
import { errorMessage } from "@/lib/log";
import type { EventRecord, Preferences } from "@/lib/types";
import { LlmError, toGeminiSchema, type LlmClient } from "./llm";
import { neutralize, RANKING_SYSTEM } from "./prompts";
import { rankEnvelopeSchema, rankItemSchema, type RankItem } from "./schemas";

const schema = toGeminiSchema(rankEnvelopeSchema);

export interface RankOutcome {
  /** Validated scores keyed by event index id ("e1"). */
  scores: Map<string, RankItem>;
  /** Index ids for which no valid score could be obtained. */
  unscored: string[];
  invalidItems: number;
  calls: number;
  errors: string[];
  /** True when the AI provider itself was unreachable (auth/quota/outage), not just a bad item. */
  providerFailed: boolean;
}

export interface RankInput {
  /** Short id for the prompt ("e1"); mapped back by the caller. */
  id: string;
  event: EventRecord;
}

function renderEvent({ id, event }: RankInput): string {
  const lines = [
    `### EVENT ${id}`,
    `title: ${neutralize(event.title)}`,
    `date: ${event.startsOn}${event.endsOn && event.endsOn !== event.startsOn ? ` to ${event.endsOn}` : ""}`,
    `city: ${event.city ?? "not stated"}`,
    `venue: ${event.venue ?? "not stated"}`,
    `format: ${event.format}`,
    `source_domains: ${[...new Set(event.sources.map((s) => s.domain))].slice(0, 4).join(", ")}`,
    `<source_text>\n${neutralize(event.sourceExcerpt ?? "(no description available)").slice(0, 700)}\n</source_text>`,
  ];
  return lines.join("\n");
}

function buildPrompt(batch: RankInput[], prefs: Pick<Preferences, "focusAreas" | "cities">, extra = ""): string {
  return `Focus areas (the consultant's professional domains):
${prefs.focusAreas.map((f) => `- ${f}`).join("\n")}

Target cities:
${prefs.cities.map((c) => `- ${c}`).join("\n")}
${extra}
Rank these ${batch.length} events.

${batch.map(renderEvent).join("\n\n")}`;
}

/** Keep only focus areas that really are in the configured list (case-insensitive, canonical spelling). */
export function sanitizeMatchedAreas(returned: string[], configured: string[]): string[] {
  const canon = new Map(configured.map((c) => [c.trim().toLowerCase(), c]));
  const out: string[] = [];
  for (const r of returned) {
    const hit = canon.get(r.trim().toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

/** Detects the "every event got the same score" failure mode on batches big enough to differ. */
export function isDegenerate(items: RankItem[]): boolean {
  return items.length >= 5 && new Set(items.map((i) => i.relevanceScore)).size === 1;
}

async function scoreBatch(
  llm: LlmClient,
  batch: RankInput[],
  prefs: Pick<Preferences, "focusAreas" | "cities">,
  extra: string,
): Promise<{ valid: RankItem[]; invalid: number }> {
  const raw = await llm.generateJson({ label: "rank", system: RANKING_SYSTEM, jsonSchema: schema, prompt: buildPrompt(batch, prefs, extra) });
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new LlmError("Response had no results array.", "invalid_json");
  const wanted = new Set(batch.map((b) => b.id));
  const seen = new Set<string>();
  const valid: RankItem[] = [];
  let invalid = 0;
  for (const entry of results) {
    const parsed = rankItemSchema.safeParse(entry);
    if (!parsed.success || !wanted.has(parsed.data.id) || seen.has(parsed.data.id)) {
      invalid += 1;
      continue;
    }
    seen.add(parsed.data.id);
    valid.push({ ...parsed.data, matchedFocusAreas: sanitizeMatchedAreas(parsed.data.matchedFocusAreas, prefs.focusAreas) });
  }
  return { valid, invalid };
}

/**
 * Gemini relevance scoring with strict, per-item validation.
 *
 *  - A score that is not an integer within 0-100 is rejected (never clamped or rounded).
 *  - Events missing a valid result get ONE targeted retry, then stay unscored.
 *  - A uniform score across a large batch is treated as a degenerate answer, retried once
 *    with a stronger instruction, then discarded.
 *  - If the provider is down the outcome says so; no score is ever fabricated.
 */
export async function rankEvents(
  llm: LlmClient,
  inputs: RankInput[],
  prefs: Pick<Preferences, "focusAreas" | "cities">,
  opts: { deadline?: number } = {},
): Promise<RankOutcome> {
  const out: RankOutcome = { scores: new Map(), unscored: [], invalidItems: 0, calls: 0, errors: [], providerFailed: false };

  for (let i = 0; i < inputs.length; i += LIMITS.rankBatchSize) {
    const batch = inputs.slice(i, i + LIMITS.rankBatchSize);
    if (out.providerFailed || (opts.deadline && Date.now() > opts.deadline)) {
      out.unscored.push(...batch.map((b) => b.id));
      if (!out.providerFailed) out.errors.push("Skipped ranking batch: run time budget exhausted.");
      continue;
    }
    try {
      out.calls += 1;
      const first = await scoreBatch(llm, batch, prefs, "");
      let valid = first.valid;
      out.invalidItems += first.invalid;

      if (isDegenerate(valid)) {
        out.calls += 1;
        const retry = await scoreBatch(llm, batch, prefs, "\nIMPORTANT: your previous answer gave every event the same score. Differentiate the events by how well each truly matches.\n");
        out.invalidItems += retry.invalid;
        valid = isDegenerate(retry.valid) ? [] : retry.valid;
        if (valid.length === 0) out.errors.push("Gemini returned identical scores for every event; scores discarded.");
      }

      let missing = batch.filter((b) => !valid.some((v) => v.id === b.id));
      if (missing.length > 0 && valid.length > 0) {
        out.calls += 1;
        const retry = await scoreBatch(llm, missing, prefs, "");
        out.invalidItems += retry.invalid;
        valid = [...valid, ...retry.valid];
        missing = batch.filter((b) => !valid.some((v) => v.id === b.id));
      }
      for (const v of valid) out.scores.set(v.id, v);
      out.unscored.push(...missing.map((m) => m.id));
    } catch (err) {
      out.errors.push(errorMessage(err));
      out.unscored.push(...batch.map((b) => b.id));
      if (err instanceof LlmError && (err.kind === "auth" || err.kind === "quota" || err.kind === "unavailable" || err.kind === "timeout")) {
        out.providerFailed = true;
      }
    }
  }
  return out;
}
