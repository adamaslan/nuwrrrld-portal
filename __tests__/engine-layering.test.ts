import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * lib/engine/ is the pure core (homebase harness/CLOUD-ENGINE.md §3.3): the
 * batch runner, the API route and any future MCP server are adapters that do
 * the I/O and call in. Same rule, same kind of test, as signals-app's
 * tests/test_layering.py. A core that fetches or reads env can't be tested
 * against the golden fixture or run the same way on every surface.
 */
const ENGINE_DIR = path.resolve(__dirname, "../lib/engine");
const FORBIDDEN: Array<[RegExp, string]> = [
  [/from\s+["']next(\/|["'])/, "imports next"],
  [/from\s+["']@neondatabase\//, "imports the Neon driver"],
  [/from\s+["']@\/lib\/(db|.*-db)["']/, "imports a db module"],
  [/from\s+["']firebase/, "imports firebase"],
  [/\bfetch\s*\(/, "calls fetch"],
  [/process\.env/, "reads process.env"],
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? tsFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("lib/engine layering", () => {
  it("has files to check", () => {
    expect(tsFiles(ENGINE_DIR).length).toBeGreaterThan(0);
  });

  for (const file of tsFiles(ENGINE_DIR)) {
    it(`${path.relative(ENGINE_DIR, file)} does no I/O`, () => {
      const source = readFileSync(file, "utf8");
      const violations = FORBIDDEN.filter(([pattern]) => pattern.test(source)).map(([, why]) => why);
      expect(violations).toEqual([]);
    });
  }
});
