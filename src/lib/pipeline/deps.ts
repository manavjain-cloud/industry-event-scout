import { createGeminiClient, type LlmClient } from "@/lib/ai/llm";
import { getDb } from "@/lib/db/client";
import type { Db } from "@/lib/db/types";
import { env } from "@/lib/env";
import { fetchPublicPage, type PageFetchOutcome, type RobotsCache } from "@/lib/input/pageFetch";
import type { SearchQuery } from "@/lib/input/queries";
import { runSearches, type SearchRunResult } from "@/lib/input/tavily";
import { createResendMailer, type Mailer } from "@/lib/output/mailer";

/**
 * Everything external the pipeline touches, injected so each can be mocked in unit
 * tests. The live implementations read their credentials lazily: a missing key fails
 * only the stage that needs it, with the variable name in the error.
 */
export interface PipelineDeps {
  db: Db;
  search(queries: SearchQuery[], deadline: number): Promise<SearchRunResult>;
  fetchPage(url: string): Promise<PageFetchOutcome>;
  llm: LlmClient;
  mailer: Mailer;
  now(): Date;
  appUrl?: string;
}

export function createLiveDeps(): PipelineDeps {
  const robotsCache: RobotsCache = new Map();
  let llm: LlmClient | undefined;
  let mailer: Mailer | undefined;
  return {
    get db() {
      return getDb();
    },
    search: (queries, deadline) => runSearches(queries, { apiKey: env("TAVILY_API_KEY"), deadline }),
    fetchPage: (url) => fetchPublicPage(url, { robotsCache }),
    llm: {
      generateJson: (req) => {
        llm ??= createGeminiClient({ apiKey: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL") });
        return llm.generateJson(req);
      },
    },
    mailer: {
      send: (msg) => {
        mailer ??= createResendMailer({ apiKey: env("RESEND_API_KEY"), from: env("RESEND_FROM_EMAIL") });
        return mailer.send(msg);
      },
    },
    now: () => new Date(),
    appUrl: process.env.NEXT_PUBLIC_APP_URL || undefined,
  };
}
