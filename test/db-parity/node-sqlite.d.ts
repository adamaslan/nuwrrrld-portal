// Minimal ambient types for node:sqlite — @types/node is pinned to ^20 in
// this repo (package.json), which predates node:sqlite (added in Node 22.5).
// The db-parity test suite requires Node 22+ to run at all (see ci.yml's
// db-parity job and __tests__/db-parity/README.md); this shim only needs to
// cover the surface test/db-parity/sqlite-sql-tag.ts actually calls.
declare module "node:sqlite" {
  export class StatementSync {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
