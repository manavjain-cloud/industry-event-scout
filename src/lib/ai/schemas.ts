import { z } from "zod";

/** ----- Relevance ranking (Components Map: AI) ----- */

/** Strictly validated: an integer from 0 to 100. Out-of-range or fractional scores are rejected, never clamped. */
export const relevanceScoreSchema = z.number().int().min(0).max(100);

export const rankItemSchema = z.object({
  id: z.string().min(1),
  relevanceScore: relevanceScoreSchema,
  relevanceReason: z.string().trim().min(5).max(320),
  summary: z.string().trim().min(10).max(420),
  matchedFocusAreas: z.array(z.string().trim().min(1)).max(8),
});
export type RankItem = z.infer<typeof rankItemSchema>;

/** Envelope sent to Gemini as the structured-output schema. Items are validated individually afterwards. */
export const rankEnvelopeSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      relevanceScore: z.number().int().describe("Integer 0-100"),
      relevanceReason: z.string(),
      summary: z.string(),
      matchedFocusAreas: z.array(z.string()),
    }),
  ),
});

/** ----- Structured extraction from source pages ----- */

const evidenced = z
  .object({
    value: z.string(),
    evidence: z.string().describe("Exact text copied from the source that states this value"),
  })
  .nullable();

export const extractEnvelopeSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      isSingleEvent: z.boolean().describe("true only if the page describes ONE specific upcoming event"),
      title: z.string().nullable(),
      startDate: evidenced.describe("YYYY-MM-DD"),
      endDate: evidenced.describe("YYYY-MM-DD"),
      city: evidenced,
      venue: evidenced,
      registrationDeadline: evidenced.describe("YYYY-MM-DD; only an explicit registration/ticket deadline"),
      registrationUrl: z.string().nullable(),
      format: z.enum(["in_person", "online", "hybrid", "unknown"]),
    }),
  ),
});

const evidencedLoose = z.object({ value: z.string(), evidence: z.string() }).nullable().catch(null);

/** Per-item validation: one malformed item must not discard the rest of a batch. */
export const extractItemSchema = z.object({
  id: z.string().min(1),
  isSingleEvent: z.boolean().catch(false),
  title: z.string().nullable().catch(null),
  startDate: evidencedLoose,
  endDate: evidencedLoose,
  city: evidencedLoose,
  venue: evidencedLoose,
  registrationDeadline: evidencedLoose,
  registrationUrl: z.string().nullable().catch(null),
  format: z.enum(["in_person", "online", "hybrid", "unknown"]).catch("unknown"),
});
export type ExtractItem = z.infer<typeof extractItemSchema>;
