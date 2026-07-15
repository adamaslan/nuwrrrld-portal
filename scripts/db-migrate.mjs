/**
 * Apply lib/db/schema.sql to the Neon database in DATABASE_URL.
 * Idempotent (IF NOT EXISTS everywhere), so it's safe to re-run.
 *
 *   npm run db:migrate           # loads .env.local via node --env-file
 *
 * Also runs as a `prebuild` step (see package.json) so every deploy —
 * Vercel included — migrates the schema before `next build` runs. On Vercel,
 * DATABASE_URL is already in process.env (project env vars); locally, if it
 * isn't already set, this falls back to reading .env.local directly so
 * `npm run build` works the same way `npm run db:migrate` does.
 *
 * Zero extra deps: plain .mjs using @neondatabase/serverless (already a dep).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  try {
    const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of envLocal.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[m[1]] = val;
      }
    }
  } catch {
    // .env.local doesn't exist (e.g. on Vercel) — process.env is the only source.
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error(
    "DATABASE_URL is not set — cannot migrate. Set it in .env.local (dev) or " +
    "the Vercel project's environment variables (prod/preview) before deploying; " +
    "every Neon-backed route will fail without it.",
  );
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
