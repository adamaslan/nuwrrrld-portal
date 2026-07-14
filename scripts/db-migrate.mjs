/**
 * Apply lib/db/schema.sql to the Neon database in DATABASE_URL.
 * Idempotent (IF NOT EXISTS everywhere), so it's safe to re-run.
 *
 *   npm run db:migrate           # loads .env.local via node --env-file
 *
 * Zero extra deps: plain .mjs using @neondatabase/serverless (already a dep).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — cannot migrate.");
  process.exit(1);
}

const schemaPath = join(process.cwd(), "lib", "db", "schema.sql");
const schema = readFileSync(schemaPath, "utf8");

// The neon HTTP driver runs one statement per call. Strip `--` line comments
// first (some contain semicolons), then split on `;`. Safe here because the
// schema has no `--` inside string literals and no function bodies.
const statements = schema
  .split("\n")
  .map((line) => {
    const idx = line.indexOf("--");
    return idx >= 0 ? line.slice(0, idx) : line;
  })
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const sql = neon(url);
for (const statement of statements) {
  await sql.query(statement);
}

console.log(`Schema applied from ${schemaPath} (${statements.length} statements).`);
