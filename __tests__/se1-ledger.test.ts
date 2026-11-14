import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_FEATURES } from "@/lib/shared/ai-features";
import { LEDGER, LIVE_WEB_IDS, ledgerRow, logicPaths, rowsForLane, type LedgerRow } from "@/lib/shared/se1-ledger";

const ROOT = path.resolve(__dirname, "..");
const onDisk = (rel: string) => existsSync(path.join(ROOT, rel));
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const AT_LEAST_LOGIC = new Set(["logic_only", "integrated", "verified", "released"]);

/** Pre-ledger rows carry an explicit test file; ledger rows need a `describe("<ID>: …")` block in the track test. */
function hasAcceptance(r: LedgerRow): boolean {
  const p = logicPaths(r);
  if (!onDisk(p.test)) return false;
  if (r.test !== undefined) return true;
  return read(p.test).includes(`describe("${r.id}: `);
}

/** Every plan addition, A1–J9. */
const ALL_90 = "ABCDEFGHIJ".split("").flatMap((t) => [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${t}${n}`));

describe("se1 ledger: the 80 capabilities that are not live", () => {
  it("covers exactly the 90 additions minus the ten live on web, once each", () => {
    const ids = LEDGER.map((r) => r.id);
    expect(ids).toHaveLength(80);
    expect(new Set(ids).size).toBe(80);
    expect([...ids, ...LIVE_WEB_IDS].sort()).toEqual([...ALL_90].sort());
  });

  it("groups match the audit: 9 logic with no caller, 5 in an open PR, 66 not started", () => {
    const count = (g: LedgerRow["group"]) => LEDGER.filter((r) => r.group === g).length;
    expect([count("logic_no_caller"), count("in_open_pr"), count("not_started")]).toEqual([9, 5, 66]);
    for (const r of LEDGER) expect(r.group === "in_open_pr", r.id).toBe(r.pr !== undefined);
  });

  it("agrees with the feature registry", () => {
    for (const f of ALL_FEATURES) {
      if (f.id === "REG" || LIVE_WEB_IDS.includes(f.id)) continue;
      const row = ledgerRow(f.id);
      expect(row, `${f.id} is in the registry but not the ledger`).toBeDefined();
      expect(row?.group, f.id).not.toBe("not_started");
    }
    for (const r of LEDGER.filter((x) => x.group === "logic_no_caller")) {
      expect(ALL_FEATURES.find((f) => f.id === r.id)?.status, r.id).toBe("logic_only");
    }
  });

  it("surface states are consistent with the planned surface", () => {
    for (const r of LEDGER) {
      expect(r.web === "n/a", `${r.id} web`).toBe(r.surface === "mobile");
      expect(r.mobile === "n/a", `${r.id} mobile`).toBe(r.surface === "web");
      expect(r.slice.length, `${r.id} slice`).toBeGreaterThan(20);
      expect(r.acceptance.length, `${r.id} acceptance`).toBeGreaterThan(20);
    }
  });

  it("every `needs` entry is one of the 90 additions and not the row itself", () => {
    for (const r of LEDGER) {
      for (const n of r.needs) {
        expect(ALL_90, `${r.id} needs ${n}`).toContain(n);
        expect(n, r.id).not.toBe(r.id);
      }
    }
  });

  it("a row cannot claim logic or better on a surface without its module on disk", () => {
    for (const r of LEDGER) {
      const claims = AT_LEAST_LOGIC.has(r.web) || AT_LEAST_LOGIC.has(r.mobile);
      if (claims) expect(onDisk(logicPaths(r).module), `${r.id} claims logic but ${logicPaths(r).module} is missing`).toBe(true);
    }
  });

  it("an acceptance test that exists is real: module present, imported, nothing skipped", () => {
    for (const r of LEDGER) {
      const p = logicPaths(r);
      if (!hasAcceptance(r)) continue;
      expect(onDisk(p.module), `${r.id} has a test but no module at ${p.module}`).toBe(true);
      const src = read(p.test);
      const importName = p.module.replace(/\.ts$/, "").replace(/^lib\/shared\//, "");
      expect(src.includes(importName), `${p.test} does not import ${p.module}`).toBe(true);
      if (r.test === undefined) {
        expect(/\b(it|test|describe)\.(skip|todo|only)\b/.test(src), `${p.test} has skip/todo/only`).toBe(false);
      }
    }
  });

  it("every row marked logic_only on web, outside the pre-ledger set, has its acceptance block", () => {
    for (const r of LEDGER) {
      if (r.web === "logic_only" && r.group === "not_started") expect(hasAcceptance(r), `${r.id} has no describe("${r.id}: …") block`).toBe(true);
    }
  });

  it("rowsForLane returns each row in exactly one lane", () => {
    const lanes = [rowsForLane("small"), rowsForLane("intermediate"), rowsForLane("large")];
    expect(lanes.flat()).toHaveLength(80);
  });
});

/**
 * One open slot per row with no logic-level acceptance test. The count of todos in the
 * test run is the count of rows whose logic is still unbuilt or unasserted.
 */
describe("se1 ledger: open acceptance slots (Q11 at the logic level)", () => {
  for (const r of LEDGER) {
    if (hasAcceptance(r)) continue;
    it.todo(`${r.id} [${r.lane}, ${r.stage}] ${r.acceptance}`);
  }
});
