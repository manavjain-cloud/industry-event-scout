import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import { errorMessage } from "@/lib/log";

/**
 * The only AI provider in the application is Gemini Flash. Everything else talks to
 * this narrow interface so tests can substitute a mock and failures are typed.
 */
export interface LlmRequest {
  system: string;
  prompt: string;
  /** JSON Schema for the response envelope (Gemini structured output). */
  jsonSchema: Record<string, unknown>;
  label: string;
}

export interface LlmClient {
  /** Returns parsed JSON (not yet trusted: callers validate it with Zod). */
  generateJson(req: LlmRequest): Promise<unknown>;
}

export type LlmErrorKind = "auth" | "quota" | "unavailable" | "invalid_json" | "blocked" | "timeout" | "unknown";

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly kind: LlmErrorKind,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/** Convert a Zod schema to the JSON Schema dialect accepted by Gemini's responseJsonSchema. */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

function classify(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const message = errorMessage(err);
  const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status: unknown }).status) : NaN;
  if (status === 401 || status === 403 || /API key|permission|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) {
    return new LlmError(`Gemini rejected the credentials or model access: ${message}`, "auth");
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
    return new LlmError(`Gemini quota or rate limit reached: ${message}`, "quota");
  }
  if (status === 503 || status === 500 || status === 504 || /UNAVAILABLE|overloaded|INTERNAL/i.test(message)) {
    return new LlmError(`Gemini is temporarily unavailable: ${message}`, "unavailable");
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return new LlmError("Gemini request timed out.", "timeout");
  }
  return new LlmError(`Gemini request failed: ${message}`, "unknown");
}

function stripFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Test hook: replace the SDK call. */
  generate?: (args: { model: string; contents: string; config: Record<string, unknown> }) => Promise<{ text?: string }>;
  sleep?: (ms: number) => Promise<void>;
}

export function createGeminiClient(opts: GeminiOptions): LlmClient {
  const ai = opts.generate ? null : new GoogleGenAI({ apiKey: opts.apiKey });
  const generate =
    opts.generate ??
    ((args: { model: string; contents: string; config: Record<string, unknown> }) =>
      ai!.models.generateContent(args as Parameters<GoogleGenAI["models"]["generateContent"]>[0]));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;

  return {
    async generateJson(req) {
      let lastError: LlmError | undefined;
      // Hidden "thinking" tokens count against maxOutputTokens and can truncate the JSON on large batches
      // (observed live). Extraction and ranking need no deep reasoning, so use the LOW level; if a model
      // rejects the setting, retry once without it.
      let useThinkingLevel = true;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await generate({
            model: opts.model,
            contents: req.prompt,
            config: {
              systemInstruction: req.system,
              responseMimeType: "application/json",
              responseJsonSchema: req.jsonSchema,
              temperature: 0.1,
              maxOutputTokens: 8192,
              ...(useThinkingLevel ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
              httpOptions: { timeout: opts.timeoutMs ?? 60_000 },
            },
          });
          const text = response.text;
          if (!text) throw new LlmError("Gemini returned an empty response (possibly blocked).", "blocked");
          try {
            return JSON.parse(stripFences(text)) as unknown;
          } catch {
            throw new LlmError("Gemini returned text that is not valid JSON.", "invalid_json");
          }
        } catch (err) {
          if (useThinkingLevel && /thinking/i.test(errorMessage(err)) && /not supported|invalid/i.test(errorMessage(err))) {
            useThinkingLevel = false;
            attempt -= 1; // the rejected setting does not consume an attempt
            continue;
          }
          lastError = classify(err);
          const retryable = lastError.kind === "unavailable" || lastError.kind === "quota" || lastError.kind === "timeout" || lastError.kind === "invalid_json";
          if (!retryable || attempt === maxAttempts) break;
          await sleep(1_500 * attempt * attempt);
        }
      }
      throw lastError ?? new LlmError("Gemini request failed.", "unknown");
    },
  };
}
