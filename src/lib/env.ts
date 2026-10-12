import "server-only";
import { z } from "zod";

/**
 * Server-only environment access. Values are read lazily so `next build` does not
 * require secrets, and a missing credential only breaks the integration that needs
 * it (reported with the variable *name*, never its value).
 */

const schemas = {
  GEMINI_API_KEY: z.string().min(10),
  GEMINI_MODEL: z.string().min(3).default("gemini-3.6-flash"),
  TAVILY_API_KEY: z.string().min(10),
  DATABASE_URL: z.string().min(10).refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgres:// URL"),
  RESEND_API_KEY: z.string().min(10),
  RESEND_FROM_EMAIL: z.string().min(5),
  CRON_SECRET: z.string().min(16, "must be at least 16 characters"),
  ADMIN_PASSWORD: z.string().min(12, "must be at least 12 characters"),
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
} as const;

export type EnvName = keyof typeof schemas;

export class MissingEnvError extends Error {
  constructor(public readonly variable: EnvName, detail: string) {
    super(`Environment variable ${variable} is missing or invalid (${detail}). See .env.example.`);
    this.name = "MissingEnvError";
  }
}

export function env<N extends EnvName>(name: N): z.infer<(typeof schemas)[N]> {
  const raw = process.env[name];
  const parsed = schemas[name].safeParse(raw === "" ? undefined : raw);
  if (!parsed.success) {
    throw new MissingEnvError(name, raw ? parsed.error.issues[0]?.message ?? "invalid" : "not set");
  }
  return parsed.data as z.infer<(typeof schemas)[N]>;
}

export function hasEnv(name: EnvName): boolean {
  return schemas[name].safeParse(process.env[name] === "" ? undefined : process.env[name]).success;
}

/** Which integrations are configured, by name only (safe to show in the dashboard). */
export function integrationStatus(): Record<string, boolean> {
  return {
    database: hasEnv("DATABASE_URL"),
    tavily: hasEnv("TAVILY_API_KEY"),
    gemini: hasEnv("GEMINI_API_KEY"),
    resend: hasEnv("RESEND_API_KEY") && hasEnv("RESEND_FROM_EMAIL"),
    cron: hasEnv("CRON_SECRET"),
  };
}
