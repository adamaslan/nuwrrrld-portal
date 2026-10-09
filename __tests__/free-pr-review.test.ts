import { describe, expect, it } from "vitest";
import { addedLineNumber, anchorQuote, globToRegExp, isFree, lensesForPath, splitDiff } from "../scripts/review/core.mjs";
import { calledIdentifiers } from "../scripts/review/context-pack.mjs";
import { verifierChain } from "../scripts/review/verify.mjs";

const DIFF = [
  "diff --git a/app/api/x/route.ts b/app/api/x/route.ts",
  "+++ b/app/api/x/route.ts",
  "@@ -3,2 +10,4 @@",
  " context line",
  "-removed line here",
  "+  const userId = body.userId;",
  "+  const first = rows[0].id;",
].join("\n");

describe("isFree", () => {
  it("requires prompt and completion priced at 0", () => {
    expect(isFree({ prompt: "0", completion: "0" })).toBe(true);
    expect(isFree({ prompt: "0", completion: "0", request: "0" })).toBe(true);
    expect(isFree({ prompt: "0" })).toBe(false);
    expect(isFree({ prompt: "0", completion: "0.000001" })).toBe(false);
    expect(isFree({ prompt: "0", completion: "0", request: "0.01" })).toBe(false);
    expect(isFree(undefined)).toBe(false);
  });
});

describe("quote anchoring", () => {
  it("returns the new-file line of the matching + line", () => {
    expect(addedLineNumber(DIFF, "const first = rows[0].id;")).toBe(12);
  });
  it("rejects quotes from removed lines and short quotes", () => {
    expect(anchorQuote(DIFF, "removed line here").anchored).toBe(false);
    expect(anchorQuote(DIFF, "+x").anchored).toBe(false);
    expect(anchorQuote(DIFF, "+  const userId = body.userId;").line).toBe(11);
  });
});

describe("path routing", () => {
  it("routes by glob and skips non-code files", () => {
    const lenses = [{ id: "a", paths: ["app/api/**"] }, { id: "b", paths: ["**/*.ts"] }];
    expect(lensesForPath(lenses, "app/api/x/route.ts").map((l: { id: string }) => l.id)).toEqual(["a", "b"]);
    expect(lensesForPath(lenses, "lib/x.ts").map((l: { id: string }) => l.id)).toEqual(["b"]);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(splitDiff(DIFF.replace(/route\.ts/g, "notes.md"))[0].skipped).toBe(true);
  });
});

describe("context pack and verifier routing", () => {
  it("collects called identifiers from + lines only", () => {
    expect(calledIdentifiers("+ hasActiveBetaGrant(meta)\n- oldThing(x)\n+ if (ok)")).toEqual(["hasActiveBetaGrant"]);
  });
  it("prefers a different vendor for the verifier", () => {
    const chain = ["nvidia/a:free", "nvidia/b:free", "liquid/c:free"];
    expect(verifierChain(chain, "nvidia/a:free")[0]).toBe("liquid/c:free");
  });
});
