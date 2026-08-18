import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, copyFile, unlink, mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Coverage for scripts/refresh-free-models.mjs and its GitHub Actions
 * integration (.github/workflows/refresh-free-models.yml) — the weekly job
 * that keeps lib/openrouter.ts's FREE_MODEL_CHAIN pointed at models that are
 * actually free and reachable. Also runnable on GCP/Modal per the script's
 * own header comment ("Runs unchanged on GCP Cloud Run, Modal, or a Zo
 * automation"), via scripts/run-refresh-remote.sh.
 *
 * These are NOT browser tests — this script has no UI and no HTTP endpoint
 * of its own, so there's nothing for page.route() to intercept. Coverage
 * here is CLI-level (spawn the real script, assert on its exit code and
 * stdout/file effects) plus workflow-file structure checks, which is what's
 * actually externally observable about this integration.
 *
 * IMPORTANT GAP this suite surfaces rather than works around: main() runs
 * unconditionally at module scope in refresh-free-models.mjs and nothing
 * (isFree, paramSize, rank, renderChain) is exported — so the script's pure
 * logic cannot be unit-tested by importing it, only by spawning the whole
 * process. If you're looking for a unit-test-level check of `isFree`'s
 * pricing-parsing edge cases, it doesn't exist yet; that's a real hole, not
 * an oversight in this suite. See test 5 below.
 */

const SCRIPT = path.resolve(process.cwd(), "scripts/refresh-free-models.mjs");
const WORKFLOW = path.resolve(process.cwd(), ".github/workflows/refresh-free-models.yml");
const REAL_TARGET = path.resolve(process.cwd(), "lib/openrouter.ts");

test.describe("refresh-free-models.mjs — CLI contract", () => {
  test("--dry-run never writes lib/openrouter.ts, even when the run otherwise succeeds", async () => {
    // NOTE: --no-probe skips the live *probe* step only — fetchFreeModels()
    // still makes one unconditional, unauthenticated call to
    // {OR_BASE}/models regardless of --no-probe, so this test needs real
    // network reachability to OpenRouter to prove anything. It intentionally
    // does NOT stub that fetch (unlike the mocked e2e/frontend/* suites):
    // the property under test is "does the CLI flag actually gate the
    // filesystem write," which has to run the real script end-to-end to mean
    // anything. If this fails with "fetch failed" rather than a
    // file-mutation assertion, that's a network/environment problem, not a
    // --dry-run regression — check connectivity to openrouter.ai before
    // treating a failure here as a code bug.
    const before = await readFile(REAL_TARGET, "utf8");

    await execFileAsync("node", [SCRIPT, "--dry-run", "--no-probe"], {
      env: { ...process.env, OPENROUTER_API_KEY: "" },
      timeout: 30_000,
    }).catch((err) => {
      throw new Error(
        `--dry-run --no-probe did not complete (network to openrouter.ai required — ` +
          `see the note above): ${err.stderr ?? err.message}`,
      );
    });

    const after = await readFile(REAL_TARGET, "utf8");
    expect(after, "lib/openrouter.ts was mutated by a --dry-run invocation").toBe(before);
  });

  test("refuses to run --probe (the default) without OPENROUTER_API_KEY", async () => {
    // This is the safety check the workflow's `env:` block exists to satisfy
    // — if this ever silently no-ops instead of hard-failing, a misconfigured
    // GHA secret would produce a silently-empty or garbage chain instead of
    // a loud, actionable CI failure.
    await expect(
      execFileAsync("node", [SCRIPT, "--dry-run"], {
        env: { ...process.env, OPENROUTER_API_KEY: "" },
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("OPENROUTER_API_KEY is required"),
    });
  });

  test("MIN_WORKING safety floor leaves the target file untouched on a near-total probe failure", async () => {
    // Point TARGET_FILE at a throwaway copy so this test can't touch the
    // real lib/openrouter.ts, then feed OPENROUTER_API_KEY a value that will
    // 401 on every probe call — simulating "the key is revoked" or "every
    // free model started rate-limiting," the exact scenario MIN_WORKING (= 1)
    // exists to guard against. Never let a bad key silently strand the app
    // on zero models.
    const scratchTarget = path.resolve(process.cwd(), ".nulogdash", "openrouter.scratch.ts");
    // .nulogdash is gitignored and only created by scripts/nulogdash.mjs — a
    // fresh checkout (or CI's clean checkout) lacks it, and both copyFile and
    // the writeFile fallback below throw ENOENT before MIN_WORKING is ever
    // exercised.
    await mkdir(path.dirname(scratchTarget), { recursive: true });
    await copyFile(REAL_TARGET, scratchTarget).catch(async () => {
      await writeFile(scratchTarget, `export const FREE_MODEL_CHAIN = [\n  "placeholder:free",\n] as const;\n`);
    });
    const before = await readFile(scratchTarget, "utf8");

    try {
      // Real network call to OpenRouter's public /models list endpoint (no
      // auth needed) followed by probes that will all 401 — this test is
      // intentionally NOT mocking fetch, because the failure mode under test
      // (every probe rejected) has to travel through the real HTTP path to
      // prove the MIN_WORKING guard actually fires end-to-end.
      // NOT shaped like a real OpenRouter key (no sk-or-v1- prefix) — this is
      // a deliberately-invalid value meant to 401 on every probe call, and a
      // realistic-looking prefix here trips secret scanners (gitleaks) on
      // every future diff touching this line for no security benefit, since
      // it was never a real credential to begin with.
      const invalidKey = "definitely-not-a-real-openrouter-key";
      await execFileAsync("node", [SCRIPT], {
        env: { ...process.env, OPENROUTER_API_KEY: invalidKey, TARGET_FILE: "lib/../.nulogdash/openrouter.scratch.ts" },
        timeout: 60_000,
      }).catch(() => {
        // Expected to exit 1 — that IS the safety behavior under test.
      });

      const after = await readFile(scratchTarget, "utf8");
      expect(after, "target file was rewritten despite every probe failing").toBe(before);
    } finally {
      await unlink(scratchTarget).catch(() => {});
    }
  });
});

test.describe("refresh-free-models.yml — GitHub Actions integration shape", () => {
  test("workflow env forwards the same OPENROUTER_API_KEY name the script reads", async () => {
    const yml = await readFile(WORKFLOW, "utf8");
    const scriptSrc = await readFile(SCRIPT, "utf8");

    // A renamed secret on one side and not the other is invisible until the
    // Monday cron runs and fails silently (or, worse, "succeeds" with
    // PROBE=false-equivalent behavior). Cross-check the literal env var name.
    expect(yml).toContain("OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}");
    expect(scriptSrc).toContain("process.env.OPENROUTER_API_KEY");
  });

  test("workflow requests contents:write + pull-requests:write, matching what create-pull-request needs", async () => {
    // peter-evans/create-pull-request needs both permissions to push a
    // branch AND open the PR. Missing either fails at PR-creation time —
    // after the (successful, costly) probe pass already ran — which is a
    // worse failure mode than catching it here before the workflow runs at
    // all.
    const yml = await readFile(WORKFLOW, "utf8");
    expect(yml).toMatch(/permissions:[\s\S]*?contents:\s*write/);
    expect(yml).toMatch(/permissions:[\s\S]*?pull-requests:\s*write/);
    expect(yml).toContain("peter-evans/create-pull-request");
  });
});
