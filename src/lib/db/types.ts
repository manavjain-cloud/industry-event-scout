export type Row = Record<string, unknown>;

export interface SqlStatement {
  text: string;
  params?: unknown[];
}

/**
 * Minimal database surface used by the application. The production implementation
 * talks to Neon over HTTPS; tests plug in PGlite (a real in-process Postgres) or a
 * failing stub to prove database errors are surfaced and never reported as success.
 */
export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs all statements as one atomic transaction and returns each result set. */
  transaction(statements: SqlStatement[]): Promise<Row[][]>;
}
