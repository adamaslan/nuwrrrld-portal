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

// Split SQL on `;` while ignoring semicolons inside single-quoted string literals
// and `--` line comments. Handles the common DDL subset used by this schema.
function splitSql(src) {
  const stmts = [];
  let buf = "";
  let inSingle = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inSingle) {
      buf += ch;
      if (ch === "'" && src[i + 1] === "'") { buf += src[++i]; } // escaped ''
      else if (ch === "'") { inSingle = false; }
    } else if (ch === "'" ) {
      inSingle = true;
      buf += ch;
    } else if (ch === "-" && src[i + 1] === "-") {
      // skip to end of line
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    } else if (ch === ";") {
      const s = buf.trim();
      if (s) stmts.push(s);
      buf = "";
    } else {
      buf += ch;
    }
    i++;
  }
  const tail = buf.trim();
  if (tail) stmts.push(tail);
  return stmts;
}

const statements = splitSql(schema);

const sql = neon(url);
for (const statement of statements) {
  await sql.query(statement);
}

console.log(`Schema applied from ${schemaPath} (${statements.length} statements).`);
