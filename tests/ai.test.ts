import { describe, expect, it, vi } from "vitest";
import { LlmError, createGeminiClient, type LlmClient, type LlmRequest } from "@/lib/ai/llm";
import { isDegenerate, rankEvents, sanitizeMatchedAreas, type RankInput } from "@/lib/ai/rank";
import { rankItemSchema, relevanceScoreSchema } from "@/lib/ai/schemas";
import { makeEvent } from "./helpers";

const prefs = { focusAreas: ["CIO roundtables", "Fintech"], cities: ["Bengaluru"] };
const inputs = (n: number): RankInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `e${i + 1}`, event: makeEvent({ title: `Event ${i + 1}` }) }));
const item = (id: string, score: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  relevanceScore: score,
  relevanceReason: "A reasonable explanation of the match.",
  summary: "A short factual summary of the event.",
  matchedFocusAreas: ["CIO roundtables"],
  ...extra,
});
const llmReturning = (...responses: unknown[]): LlmClient & { calls: number } => {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generateJson() {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  };
};

describe("relevance score validation (0-100 integers only)", () => {
  it.each([0, 1, 50, 99, 100])("accepts %i", (n) => expect(relevanceScoreSchema.safeParse(n).success).toBe(true));
  it.each([-1, 101, 250, 55.5, Number.NaN, "88", null, undefined])("rejects %s", (v) => expect(relevanceScoreSchema.safeParse(v).success).toBe(false));
  it("requires the other fields too", () => {
    expect(rankItemSchema.safeParse(item("e1", 80, { summary: "" })).success).toBe(false);
    expect(rankItemSchema.safeParse(item("e1", 80, { matchedFocusAreas: "x" })).success).toBe(false);
  });
});

describe("rankEvents - malformed and out-of-range Gemini output", () => {
  it("discards out-of-range and fractional scores instead of clamping them", async () => {
    const llm = llmReturning(
      { results: [item("e1", 150), item("e2", 77.5), item("e3", 90), item("e4", "high")] },
      { results: [item("e1", 150), item("e2", 40)] }, // targeted retry for the missing ones
    );
    const out = await rankEvents(llm, inputs(4), prefs);
    expect(out.scores.get("e3")?.relevanceScore).toBe(90);
    expect(out.scores.get("e2")?.relevanceScore).toBe(40);
    expect(out.scores.has("e1")).toBe(false); // 150 stays rejected even after the retry
    expect(out.scores.has("e4")).toBe(false);
    expect([...out.unscored].sort()).toEqual(["e1", "e4"]);
    expect(out.invalidItems).toBeGreaterThanOrEqual(3);
  });

  it("treats a response with no results array as a failure for the batch", async () => {
    const out = await rankEvents(llmReturning({ oops: true }), inputs(3), prefs);
    expect(out.scores.size).toBe(0);
    expect(out.unscored).toHaveLength(3);
    expect(out.errors[0]).toMatch(/no results/i);
    expect(out.providerFailed).toBe(false);
  });

  it("treats non-object JSON (string, null, array) as a failure, never as scores", async () => {
    for (const bad of ["not json at all", null, [1, 2, 3], 42]) {
      const out = await rankEvents(llmReturning(bad), inputs(2), prefs);
      expect(out.scores.size).toBe(0);
      expect(out.unscored).toHaveLength(2);
    }
  });

  it("ignores unknown ids and duplicates in the response", async () => {
    const out = await rankEvents(llmReturning({ results: [item("e1", 70), item("e1", 10), item("zzz", 99)] }), inputs(1), prefs);
    expect(out.scores.get("e1")?.relevanceScore).toBe(70);
    expect(out.scores.has("zzz")).toBe(false);
  });

  it("detects and discards 'same score for everything' answers", async () => {
    const same = { results: inputs(6).map((i) => item(i.id, 70)) };
    expect(isDegenerate(same.results.map((r) => rankItemSchema.parse(r)))).toBe(true);
    const out = await rankEvents(llmReturning(same, same), inputs(6), prefs);
    expect(out.scores.size).toBe(0);
    expect(out.errors.join(" ")).toMatch(/identical scores/);
  });

  it("recovers when the retry differentiates the scores", async () => {
    const same = { results: inputs(6).map((i) => item(i.id, 70)) };
    const varied = { results: inputs(6).map((i, n) => item(i.id, 30 + n * 10)) };
    const out = await rankEvents(llmReturning(same, varied), inputs(6), prefs);
    expect(out.scores.size).toBe(6);
  });

  it("only keeps matched focus areas that really are configured", () => {
    expect(sanitizeMatchedAreas(["cio roundtables", "Underwater basket weaving", "Fintech", "FINTECH"], prefs.focusAreas)).toEqual(["CIO roundtables", "Fintech"]);
  });

  it("stops calling Gemini after an outage and flags provider failure without scores", async () => {
    const llm = llmReturning(new LlmError("Gemini is temporarily unavailable", "unavailable"));
    const out = await rankEvents(llm, inputs(25), prefs);
    expect(out.providerFailed).toBe(true);
    expect(out.scores.size).toBe(0);
    expect(out.unscored).toHaveLength(25);
    expect(llm.calls).toBe(1); // later batches skipped, quota not wasted
  });

  it("batches large inputs", async () => {
    const llm = llmReturning({ results: [] });
    await rankEvents(llm, inputs(25), prefs);
    expect(llm.calls).toBeGreaterThanOrEqual(3);
  });
});

describe("Gemini client", () => {
  const req: LlmRequest = { system: "s", prompt: "p", jsonSchema: { type: "object" }, label: "t" };
  const sleep = async () => undefined;

  it("parses JSON (including fenced JSON) and sends the configured model and schema", async () => {
    const generate = vi.fn(async () => ({ text: '```json\n{"results":[1]}\n```' }));
    const client = createGeminiClient({ apiKey: "k".repeat(12), model: "gemini-x-flash", generate, sleep });
    expect(await client.generateJson(req)).toEqual({ results: [1] });
    const args = generate.mock.calls[0] as unknown as [{ model: string; config: Record<string, unknown> }];
    expect(args[0].model).toBe("gemini-x-flash");
    expect(args[0].config.responseMimeType).toBe("application/json");
    expect(args[0].config.responseJsonSchema).toEqual({ type: "object" });
  });

  it("retries transient failures then succeeds", async () => {
    const generate = vi
      .fn<() => Promise<{ text?: string }>>()
      .mockRejectedValueOnce(Object.assign(new Error("model overloaded"), { status: 503 }))
      .mockResolvedValueOnce({ text: '{"ok":true}' });
    const client = createGeminiClient({ apiKey: "k".repeat(12), model: "m", generate, sleep });
    expect(await client.generateJson(req)).toEqual({ ok: true });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [Object.assign(new Error("API key not valid"), { status: 403 }), "auth", 1],
    [Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }), "quota", 3],
    [Object.assign(new Error("boom"), { status: 503 }), "unavailable", 3],
  ])("classifies %s as %s", async (error, kind, attempts) => {
    const generate = vi.fn(async () => {
      throw error;
    });
    const client = createGeminiClient({ apiKey: "k".repeat(12), model: "m", generate, sleep });
    await expect(client.generateJson(req)).rejects.toMatchObject({ kind });
    expect(generate).toHaveBeenCalledTimes(attempts);
  });

  it("asks for a LOW thinking level and retries without it if the model rejects the setting", async () => {
    const generate = vi
      .fn<(a: { config: Record<string, unknown> }) => Promise<{ text?: string }>>()
      .mockRejectedValueOnce(Object.assign(new Error("Thinking level LOW is not supported for this model"), { status: 400 }))
      .mockResolvedValueOnce({ text: '{"ok":1}' });
    const client = createGeminiClient({ apiKey: "k".repeat(12), model: "m", generate: generate as never, sleep, maxAttempts: 1 });
    expect(await client.generateJson(req)).toEqual({ ok: 1 });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(generate.mock.calls[1][0].config.thinkingConfig).toBeUndefined();
  });

  it("fails with invalid_json when the model returns prose", async () => {
    const generate = vi.fn(async () => ({ text: "Sure! Here are your events..." }));
    const client = createGeminiClient({ apiKey: "k".repeat(12), model: "m", generate, sleep, maxAttempts: 2 });
    await expect(client.generateJson(req)).rejects.toMatchObject({ kind: "invalid_json" });
  });

  it("fails clearly on an empty (blocked) response", async () => {
    const generate = vi.fn(async () => ({ text: "" }));
    const client = createGeminiClient({ apiKey: "k".repeat(12), model: "m", generate, sleep });
    await expect(client.generateJson(req)).rejects.toMatchObject({ kind: "blocked" });
  });
});
