import { describe, expect, it } from "vitest";
import { validateEvidenceReceipt } from "@/scripts/validate-evidence-receipt.mjs";
import { buildJudgePrompt } from "@/lib/eval-judge";
import type { StructuredVerdict } from "@/lib/council-verdict";

type TestReceipt = {
  headSha?: string; sourceUrl?: string;
  checks: Array<{ name?: string; kind?: string; status?: string; claimed?: string }>;
  tasks: Array<{ id?: string; checked?: boolean; evidence?: string }>;
  reviewer: { claimedIndependent?: boolean; isAuthor?: boolean; identityAttestation?: { signature?: string; keyId?: string; trustAnchorUrl?: string } };
  preview?: { url?: string; headSha?: string };
  database?: { mode?: string; claimedReal?: boolean };
  ui?: { mode?: string; claimedProduction?: boolean };
  runtime?: { claimedCause?: boolean; evidence?: string };
  completedAt?: string; checkedAt?: string; completionEvidence?: { sourceUrl?: string; observedAt?: string };
  schedule?: { usesExpectedTime?: boolean; sourceUrl?: string; sourceCheckedAt?: string };
  query?: { error?: unknown; claimedSuccess?: boolean };
  fileClaims?: Array<{ writer?: string; files?: string[] }>;
  provider?: { claimedFreeOnly?: boolean; mode?: string };
  connection?: { claimedOffline?: boolean; mode?: string };
  containsSecret?: boolean;
  secret?: string;
};

const good = (): TestReceipt => ({
  headSha: "a".repeat(40), sourceUrl: "https://github.com/example/repo/blob/main/file.ts",
  checks: [{ name: "unit", status: "passed", claimed: "passed", kind: "test" }],
  tasks: [{ id: "N-0181", checked: true, evidence: "unit test output" }],
  reviewer: { claimedIndependent: true, isAuthor: false, identityAttestation: { signature: "verified-signature", keyId: "reviewer-key-1", trustAnchorUrl: "https://example.com/key" } },
});

describe("evidence receipt validator", () => {
  it("accepts a fully evidenced receipt", () => expect(validateEvidenceReceipt(good()).valid).toBe(true));
  const rejects: [string, (r: TestReceipt) => void, string][] = [
    ["missing head SHA", r => { r.headSha = undefined; }, "head.missing-or-ambiguous"],
    ["short ambiguous SHA", r => { r.headSha = "abc1234"; }, "head.missing-or-ambiguous"],
    ["preview for another commit", r => { r.preview = { url: "https://preview.example", headSha: "b".repeat(40) }; }, "preview.head-mismatch"],
    ["typecheck called a full build", r => { r.checks.push({ name: "full-build", kind: "typecheck" }); }, "build.typecheck-mislabeled"],
    ["skipped check called passed", r => { r.checks.push({ name: "ci", status: "skipped", claimed: "passed" }); }, "check.skipped-claimed-passed"],
    ["mock DB called real", r => { r.database = { mode: "mock", claimedReal: true }; }, "database.mock-claimed-real"],
    ["synthetic UI called production", r => { r.ui = { mode: "synthetic", claimedProduction: true }; }, "ui.synthetic-claimed-production"],
    ["unsigned reviewer identity", r => { r.reviewer.identityAttestation = undefined; }, "reviewer.identity-unverified"],
    ["author called independent", r => { r.reviewer.isAuthor = true; }, "reviewer.is-author"],
    ["fixture called runtime cause", r => { r.runtime = { claimedCause: true, evidence: "fixture" }; }, "runtime.fixture-claimed-cause"],
    ["missing source URL", r => { r.sourceUrl = ""; }, "source.url-missing"],
    ["unsupported completion timestamp", r => { r.completedAt = "2026-11-15T00:00:00Z"; }, "completion.timestamp-unsubstantiated"],
    ["stale expected schedule time", r => { r.checkedAt = "2026-11-15T16:00:00Z"; r.schedule = { usesExpectedTime: true, sourceUrl: "https://example.com/schedule", sourceCheckedAt: "2026-10-01T00:00:00Z" }; }, "schedule.expected-time-unsupported"],
    ["query error called success", r => { r.query = { error: "read failed", claimedSuccess: true }; }, "query.error-claimed-success"],
    ["duplicate task IDs", r => { r.tasks.push({ id: "N-0181" }); }, "task.duplicate-id"],
    ["overlapping file writers", r => { r.fileClaims = [{ writer: "a", files: ["lib/x.ts"] }, { writer: "b", files: ["lib/x.ts"] }]; }, "files.multiple-writers"],
    ["paid provider called free-only", r => { r.provider = { claimedFreeOnly: true, mode: "paid" }; }, "provider.paid-under-free-only"],
    ["live DB under offline claim", r => { r.connection = { claimedOffline: true, mode: "live" }; }, "connection.live-under-offline"],
    ["secret value in receipt", r => { r.secret = "not-a-real-secret-for-test"; }, "receipt.contains-secret"],
    ["unfinished task checked", r => { r.tasks[0] = { id: "N-0181", checked: true }; }, "task.checked-without-evidence"],
  ];
  it.each(rejects)("rejects %s", (_label, mutate, error) => {
    const receipt = good(); mutate(receipt);
    expect(validateEvidenceReceipt(receipt).errors).toContain(error);
  });
});

describe("Judge frozen input boundary", () => {
  const verdict: StructuredVerdict = { outlook: "bullish", because: "evidence", invalidation: "below 10", execution: "buy 10" };
  it("preserves exact and Unicode frozen brief text in the real prompt", () => {
    const brief = "Frozen brief: price 10.00 — café 東京 👋";
    expect(buildJudgePrompt(verdict, brief)).toContain(`=== BRIEF THE VERDICT WAS GROUNDED ON ===\n${brief}\n`);
  });
  it("does not let outcome-only extra fields enter the real Judge prompt", () => {
    const injected = { ...verdict, realizedReturn: 42, resolvedOutcome: "hit" } as StructuredVerdict;
    const prompt = buildJudgePrompt(injected, "frozen");
    expect(prompt).not.toContain("realizedReturn");
    expect(prompt).not.toContain("resolvedOutcome");
  });
});
