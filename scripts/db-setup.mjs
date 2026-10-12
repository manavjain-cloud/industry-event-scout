#!/usr/bin/env node
/**
 * Applies db/migrations/*.sql to the Neon database in DATABASE_URL (from .env.local or the
 * environment). Idempotent: applied versions are recorded in schema_migrations.
 *
 *   npm run db:setup
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env.local"), quiet: true });
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const url = process.env.DATABASE_URL;
if (!url || !/^postgres(ql)?:\/\//.test(url)) {
  console.error("DATABASE_URL is not set (or is not a postgres:// URL). Add it to .env.local - see .env.example.");
  process.exit(1);
}

const sql = neon(url);

/** Strip `--` comments, then split into statements on `;` at end of line. Migrations contain no procedural bodies. */
function statements(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

try {
  await sql.query(`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await sql.query(`select version from schema_migrations`)).map((r) => r.version));
  const dir = path.join(root, "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`- ${file}: already applied`);
      continue;
    }
    const stmts = statements(readFileSync(path.join(dir, file), "utf8"));
    await sql.transaction((txn) => [...stmts.map((s) => txn.query(s)), txn.query(`insert into schema_migrations (version) values ($1)`, [file])]);
    console.log(`+ ${file}: applied (${stmts.length} statements)`);
    ran += 1;
  }
  const tables = await sql.query(`select table_name from information_schema.tables where table_schema = 'public' order by table_name`);
  console.log(`\nDone. ${ran} migration(s) applied. Tables: ${tables.map((t) => t.table_name).join(", ")}`);
} catch (err) {
  console.error("Database setup failed:", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, "[redacted]") : err);
  process.exit(1);
}
