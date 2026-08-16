/**
 * Setup for the "live" vitest project — the tests that actually call the
 * models instead of stubbing `fetch`.
 *
 * Loads .env.local into process.env (vitest, unlike `node --env-file`, does
 * not do this) so live tests read the same OPENROUTER_API_KEY the dev server
 * uses. Nothing here fabricates a key: if there isn't one, the live tests
 * skip themselves loudly rather than failing or silently passing.
 */
import fs from "node:fs";
import path from "node:path";

const ENV_FILE = path.resolve(process.cwd(), ".env.local");

function loadEnvLocal(): void {
  if (!fs.existsSync(ENV_FILE)) return;
  for (const rawLine of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    // Never clobber a value the caller exported explicitly (CI secrets win).
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvLocal();

if (!process.env.OPENROUTER_API_KEY) {
  console.warn(
    "\n[live] OPENROUTER_API_KEY not set — every live AI test will SKIP.\n" +
      "[live] A green run in this state proves nothing about the models.\n",
  );
}
