import { neon } from "@neondatabase/serverless";
import { env } from "@/lib/env";
import type { Db, Row, SqlStatement } from "./types";

/** Neon over HTTPS: one round trip per query, one per transaction batch. */
export function createNeonDb(connectionString: string): Db {
  const sql = neon(connectionString);
  return {
    async query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await sql.query(text, params)) as T[];
    },
    async transaction(statements: SqlStatement[]): Promise<Row[][]> {
      if (statements.length === 0) return [];
      const results = await sql.transaction((txn) => statements.map((s) => txn.query(s.text, s.params ?? [])));
      return results as Row[][];
    },
  };
}

let cached: Db | undefined;

/** Lazily constructed shared client (throws MissingEnvError if DATABASE_URL is absent). */
export function getDb(): Db {
  cached ??= createNeonDb(env("DATABASE_URL"));
  return cached;
}
