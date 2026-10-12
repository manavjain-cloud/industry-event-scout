#!/usr/bin/env node
/**
 * Live integration smoke check using the credentials in .env.local. It prints PASS/FAIL per
 * service and never prints a secret. Costs: 1 Tavily credit and 2 tiny Gemini requests.
 * It does NOT send any email (Resend is verified by listing domains).
 *
 *   npm run check:integrations            # everything configured
 *   npm run check:integrations -- gemini  # one service: database | tavily | gemini | resend
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";
import { Resend } from "resend";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });

const only = process.argv[2];
const redact = (s) => String(s).replace(/(tvly-|AIza|AQ.|re_|napi_)[A-Za-z0-9_-]+/g, "$1***").replace(/postgres(ql)?:\/\/\S+/g, "[redacted]");
const results = [];
const run = async (name, fn) => {
  if (only && only !== name) return;
  const missing = REQUIRED[name].filter((k) => !process.env[k]);
  if (missing.length) {
    results.push([name, "SKIP", `missing ${missing.join(", ")}`]);
    return;
  }
  try {
    results.push([name, "PASS", await fn()]);
  } catch (err) {
    results.push([name, "FAIL", redact(err instanceof Error ? err.message : err).slice(0, 300)]);
  }
};
const REQUIRED = { database: ["DATABASE_URL"], tavily: ["TAVILY_API_KEY"], gemini: ["GEMINI_API_KEY", "GEMINI_MODEL"], resend: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"] };

await run("database", async () => {
  const sql = neon(process.env.DATABASE_URL);
  const t = await sql.query(`select table_name from information_schema.tables where table_schema='public' and table_name in ('user_preferences','events','event_sources','digest_runs','digest_run_events')`);
  if (t.length < 5) throw new Error(`connected, but only ${t.length}/5 tables exist - run "npm run db:setup"`);
  return "connected; schema present";
});

await run("tavily", async () => {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query: "CIO roundtable Bengaluru 2026", search_depth: "basic", max_results: 3, include_usage: true }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? " (invalid key)" : res.status === 432 || res.status === 433 ? " (plan limit)" : ""}`);
  const json = await res.json();
  return `${json.results?.length ?? 0} results, credits used: ${json.usage?.credits ?? "?"}`;
});

await run("gemini", async () => {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = process.env.GEMINI_MODEL;
  const names = [];
  for await (const m of await ai.models.list({ config: { pageSize: 100 } })) names.push(String(m.name).replace(/^models\//, ""));
  const flash = names.filter((n) => /flash/i.test(n) && !/(image|tts|live|audio|embedding|robotics)/i.test(n));
  if (!names.includes(model)) throw new Error(`model "${model}" is not available to this key. Flash models available: ${flash.join(", ") || "none listed"}`);
  const out = await ai.models.generateContent({
    model,
    contents: 'Return JSON {"ok": true, "score": 73}',
    config: { responseMimeType: "application/json", maxOutputTokens: 256, thinkingConfig: { thinkingLevel: "LOW" } },
  });
  const parsed = JSON.parse(out.text ?? "{}");
  if (parsed.ok !== true) throw new Error("model answered but not with the requested JSON");
  return `model ${model} reachable, structured JSON ok`;
});

await run("resend", async () => {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.domains.list();
  if (error) {
    // A "restricted" (send-only) key cannot list domains; that is still a valid sending key.
    if (/restricted/i.test(`${error.name} ${error.message}`)) return "send-only key accepted (cannot list domains) - verify by sending a test from the dashboard";
    throw new Error(`${error.name}: ${error.message}`);
  }
  const verified = (data?.data ?? []).filter((d) => d.status === "verified").map((d) => d.name);
  const from = process.env.RESEND_FROM_EMAIL;
  return verified.length ? `key ok; verified domains: ${verified.join(", ")}` : `key ok; no verified domain - only onboarding@resend.dev -> your own account email works (from: ${from.includes("resend.dev") ? "resend.dev" : "custom"})`;
});

console.log("");
for (const [name, status, detail] of results) console.log(`${status.padEnd(5)} ${name.padEnd(9)} ${detail}`);
process.exit(results.some((r) => r[1] === "FAIL") ? 1 : 0);
