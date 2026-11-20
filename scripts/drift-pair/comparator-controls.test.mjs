// Runs the REAL scripts/check-shared-drift.mjs on synthetic 13-file trees.
// Run: node --test scripts/drift-pair/comparator-controls.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const checker = resolve(here, "..", "check-shared-drift.mjs");

// The 13 shared paths the checker enforces (must match PAIRS in the checker).
const SHARED = [
  "lib/shared/sse.ts", "lib/digest.ts", "lib/signalCard.ts", "lib/subscription.ts",
  "lib/shared/signalFilters.ts", "lib/shared/prefs.ts", "lib/shared/signal-policy.ts",
  "lib/shared/live-price.ts", "lib/shared/attribution.ts", "lib/shared/consent.ts",
  "lib/shared/legal-consent.ts", "lib/retention.ts", "lib/portfolio.ts",
];

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "drift-tree-"));
  for (const path of SHARED) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, files[path] ?? `export const v = "${path}";\n`);
  }
  return root;
}

function runChecker(web, mobile) {
  const r = spawnSync(process.execPath, [checker], {
    env: { ...process.env, WEB_ROOT: web, MOBILE_ROOT: mobile },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const DIGEST_NEW = "export const digest = 'new-request-timestamp-unknown';\n";
const DIGEST_OLD = "export const digest = 'old-generatedAt-fallback';\n";

test("control: every shared pair identical -> passes and checks all 13 paths", () => {
  const web = tree({});
  const mobile = tree({});
  const r = runChecker(web, mobile);
  assert.equal(r.code, 0, r.err);
  assert.equal((r.out.match(/✓ /g) ?? []).length, 13);
  assert.match(r.out, /All shared files in sync/);
});

test("control: mismatched shared blob (digest) -> retained failure", () => {
  const web = tree({ "lib/digest.ts": DIGEST_NEW });
  const mobile = tree({ "lib/digest.ts": DIGEST_OLD });
  const r = runChecker(web, mobile);
  assert.equal(r.code, 1);
  assert.match(r.err, /lib\/digest\.ts: web and mobile copies have drifted/);
});

test("defect reproduced: default-branch comparison fails when the PR changed digest", () => {
  // Web = the PR head. Mobile default branch = still the old digest.
  // This is the original gate behavior that fails the paired PR.
  const web = tree({ "lib/digest.ts": DIGEST_NEW });
  const mobileDefault = tree({ "lib/digest.ts": DIGEST_OLD });
  const r = runChecker(web, mobileDefault);
  assert.equal(r.code, 1, "old default-branch comparison must fail");
});

test("fix: paired comparison against the counterpart PR head passes", () => {
  // Same web head. Mobile = the paired PR head, which carries the identical digest.
  const web = tree({ "lib/digest.ts": DIGEST_NEW });
  const mobilePairedHead = tree({ "lib/digest.ts": DIGEST_NEW });
  const r = runChecker(web, mobilePairedHead);
  assert.equal(r.code, 0, r.err);
});

test("a changed seam-free file still trips the gate (no weakening)", () => {
  const web = tree({ "lib/retention.ts": "export const keep = 30;\n" });
  const mobile = tree({ "lib/retention.ts": "export const keep = 31;\n" });
  const r = runChecker(web, mobile);
  assert.equal(r.code, 1);
  assert.match(r.err, /lib\/retention\.ts/);
});

test("missing counterpart file is reported as unreadable, not skipped", () => {
  const web = tree({});
  const mobile = mkdtempSync(join(tmpdir(), "drift-empty-"));
  const r = runChecker(web, mobile);
  assert.equal(r.code, 1);
  assert.match(r.err, /could not read/);
});

// Keep execFileSync imported for symmetry with the offline harness used in verification.
void execFileSync;
