import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { Db, Row, SqlStatement } from "@/lib/db/types";

/** A real (in-process) Postgres with the production migrations applied. */
export async function createTestDb(): Promise<{ db: Db; pg: PGlite }> {
  const pg = new PGlite();
  const dir = path.join(process.cwd(), "db", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(path.join(dir, file), "utf8"));
  }
  const db: Db = {
    async query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
      const res = await pg.query<T>(text, params);
      return res.rows;
    },
    async transaction(statements: SqlStatement[]): Promise<Row[][]> {
      return pg.transaction(async (tx) => {
        const out: Row[][] = [];
        for (const s of statements) out.push((await tx.query<Row>(s.text, s.params ?? [])).rows);
        return out;
      });
    },
  };
  return { db, pg };
}

/** A Db whose every call rejects - proves failures are surfaced, never reported as success. */
export function failingDb(message = "connection refused"): Db {
  return {
    async query() {
      throw new Error(message);
    },
    async transaction() {
      throw new Error(message);
    },
  };
}
