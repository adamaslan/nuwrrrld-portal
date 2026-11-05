#!/usr/bin/env node
// Trusted paired-drift resolver for the shared-core drift gate.
//
// Decides which counterpart commit the drift check compares against:
//   - an UNPAIRED PR compares against the counterpart repo's default branch;
//   - a PAIRED PR (explicit reciprocal `drift-pair:` references, both sides
//     open, same-repo heads, base main) compares against the counterpart PR's
//     frozen head SHA.
// A pair that is requested but invalid, unreachable or non-reciprocal FAILS
// CLOSED: the resolver throws and never falls back to the default branch.
//
// Trust boundary: this file is trusted code, loaded from the BASE branch by
// the workflow. All PR metadata (titles, bodies, branch names, refs) is
// untrusted data. It is matched against strict patterns, never executed,
// never interpolated into a shell, and never used as a filesystem path.
// No secrets, no privileged events, no counterpart code execution.
//
// Stdlib only (node >= 20). The API is injectable so the logic is testable
// without network access; see resolve-pair.test.mjs.

import { execFile } from "node:child_process";

// Exact repository pairs that may be compared. Anything else is refused.
export const ALLOWED_PAIRS = Object.freeze([
  Object.freeze({
    web: "adamaslan/nuwrrrld-portal",
    mobile: "adamaslan/gcp-expo1",
  }),
]);

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PR_NUMBER_RE = /^[1-9][0-9]{0,6}$/;
// Reciprocal pair reference, one per PR body, on its own line.
const PAIR_LINE_RE =
  /^drift-pair:[ \t]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,6})[ \t]*$/gm;
// Optional declared pin of the counterpart head SHA, checked when present.
const PIN_LINE_RE =
  /^drift-pair-sha:[ \t]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})[ \t]*$/gm;

export class PairError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PairError";
    this.code = code;
  }
}

/** Return the allowlisted counterpart of `repo`, or null if none. */
export function counterpartOf(repo) {
  for (const pair of ALLOWED_PAIRS) {
    if (pair.web === repo) return pair.mobile;
    if (pair.mobile === repo) return pair.web;
  }
  return null;
}

/** Exactly one match of a strict line pattern, or null. Two is an error. */
function singleMatch(re, text) {
  const matches = [...String(text ?? "").matchAll(re)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new PairError("ambiguous-metadata", "more than one matching line");
  }
  return matches[0];
}

function requireRepo(value, code) {
  if (typeof value !== "string" || !REPO_RE.test(value)) {
    throw new PairError(code, "repository name is not in owner/name form");
  }
  return value;
}

function requireSha(value, code) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    throw new PairError(code, "head SHA is not a full 40-hex commit id");
  }
  return value;
}

/** Normalize one PR snapshot. Untrusted input: every field is validated. */
function checkedPull(raw, repo, number, label) {
  if (!raw || typeof raw !== "object") {
    throw new PairError("api-unavailable", `${label}: no PR data returned`);
  }
  const headRepo = raw.head?.repo?.full_name ?? null;
  const baseRepo = raw.base?.repo?.full_name ?? null;
  return {
    number,
    state: raw.state,
    draft: raw.draft === true,
    body: typeof raw.body === "string" ? raw.body : "",
    baseRef: raw.base?.ref ?? null,
    baseRepo,
    headRef: raw.head?.ref ?? null,
    headRepo,
    headSha: requireSha(raw.head?.sha, "bad-sha"),
    repo,
  };
}

function assertOpenSameRepoMain(pull, label, code) {
  if (pull.state !== "open") {
    throw new PairError(code, `${label} PR #${pull.number} is not open`);
  }
  if (pull.headRepo !== pull.repo) {
    throw new PairError("fork", `${label} PR #${pull.number} head is not in ${pull.repo}`);
  }
  if (pull.baseRepo !== pull.repo || pull.baseRef !== "main") {
    throw new PairError("wrong-base", `${label} PR #${pull.number} does not target main`);
  }
}

/**
 * Resolve the counterpart to compare against.
 *
 * @param {object} args
 * @param {object} args.api   injectable adapter: { getPull(repo, n), getDefaultSha(repo) }
 * @param {string} args.repo  owner/name of the repository running the gate
 * @param {string|number|null} [args.pr]  PR number, or null for a push run
 * @returns {Promise<{mode: "paired"|"default", own: object, counterpart: object}>}
 */
export async function resolvePair({ api, repo, pr = null }) {
  requireRepo(repo, "bad-repo");
  const counterparty = counterpartOf(repo);
  if (!counterparty) {
    throw new PairError("not-allowlisted", `${repo} is not in ALLOWED_PAIRS`);
  }

  // A push run has no PR: compare the two default branches.
  if (pr === null || pr === undefined || pr === "") {
    const sha = requireSha(await safeDefaultSha(api, counterparty), "bad-sha");
    return {
      mode: "default",
      own: { repo, pr: null, sha: null },
      counterpart: { repo: counterparty, pr: null, sha },
    };
  }

  const prText = String(pr);
  if (!PR_NUMBER_RE.test(prText)) {
    throw new PairError("bad-pr-number", "PR number is not a positive integer");
  }
  const ownNumber = Number(prText);
  const own = checkedPull(await safeGetPull(api, repo, ownNumber), repo, ownNumber, "own");
  assertOpenSameRepoMain(own, "own", "own-state");

  const pairMatch = singleMatch(PAIR_LINE_RE, own.body);
  if (!pairMatch) {
    // Unpaired: ordinary default-branch comparison. Never skips parity.
    const sha = requireSha(await safeDefaultSha(api, counterparty), "bad-sha");
    return {
      mode: "default",
      own: { repo, pr: ownNumber, sha: own.headSha },
      counterpart: { repo: counterparty, pr: null, sha },
    };
  }

  const [, claimedRepo, claimedNumberText] = pairMatch;
  if (claimedRepo !== counterparty) {
    throw new PairError("wrong-repo", "pair reference names a repository outside the allowlist pair");
  }
  const counterNumber = Number(claimedNumberText);
  const counter = checkedPull(
    await safeGetPull(api, counterparty, counterNumber),
    counterparty,
    counterNumber,
    "counterpart",
  );
  assertOpenSameRepoMain(counter, "counterpart", "counterpart-state");

  // Reciprocity: the counterpart must name this PR back, exactly once.
  const back = singleMatch(PAIR_LINE_RE, counter.body);
  if (!back || back[1] !== repo || back[2] !== String(ownNumber)) {
    throw new PairError("nonreciprocal", "counterpart PR does not reference this PR back");
  }

  // Declared pins, if present, must match the live heads. Pins are optional
  // and never replace the live SHA check below.
  const ownPin = singleMatch(PIN_LINE_RE, own.body);
  if (ownPin && (ownPin[1] !== counterparty || ownPin[2] !== counter.headSha)) {
    throw new PairError("pin-mismatch", "declared counterpart pin does not match its live head");
  }
  const counterPin = singleMatch(PIN_LINE_RE, counter.body);
  if (counterPin && (counterPin[1] !== repo || counterPin[2] !== own.headSha)) {
    throw new PairError("pin-mismatch", "counterpart pin does not match this PR's live head");
  }

  return {
    mode: "paired",
    own: { repo, pr: ownNumber, sha: own.headSha },
    counterpart: { repo: counterparty, pr: counterNumber, sha: counter.headSha },
  };
}

/**
 * Recheck both heads after the comparison. A moved head invalidates the result.
 * @returns {Promise<void>} resolves when both heads are unchanged; throws PairError otherwise.
 */
export async function recheckFrozen({ api, resolved }) {
  const { own, counterpart, mode } = resolved;
  if (own.pr !== null) {
    const now = checkedPull(await safeGetPull(api, own.repo, own.pr), own.repo, own.pr, "own");
    assertOpenSameRepoMain(now, "own", "own-state");
    if (now.headSha !== own.sha) {
      throw new PairError("moved-head", "own PR head changed during comparison");
    }
  }
  if (mode === "paired") {
    const now = checkedPull(
      await safeGetPull(api, counterpart.repo, counterpart.pr),
      counterpart.repo,
      counterpart.pr,
      "counterpart",
    );
    assertOpenSameRepoMain(now, "counterpart", "counterpart-state");
    if (now.headSha !== counterpart.sha) {
      throw new PairError("moved-head", "counterpart PR head changed during comparison");
    }
  } else {
    // Unpaired: the counterpart default branch must not have moved either.
    const sha = await safeDefaultSha(api, counterpart.repo);
    if (sha !== counterpart.sha) {
      throw new PairError("moved-head", "counterpart default branch moved during comparison");
    }
  }
}

async function safeGetPull(api, repo, number) {
  try {
    return await api.getPull(repo, number);
  } catch (err) {
    if (err instanceof PairError) throw err;
    throw new PairError("api-unavailable", "PR lookup failed");
  }
}

async function safeDefaultSha(api, repo) {
  try {
    return await api.getDefaultSha(repo);
  } catch (err) {
    if (err instanceof PairError) throw err;
    throw new PairError("api-unavailable", "default-branch lookup failed");
  }
}

// ---------- CLI (used by the workflow) ----------

/** Live adapter over the `gh` CLI. Arguments are passed as an array, never a shell string. */
export function ghAdapter(exec = execFile) {
  const ghJson = (args) =>
    new Promise((resolve, reject) => {
      exec("gh", ["api", ...args], { maxBuffer: 1 << 20 }, (err, stdout) => {
        if (err) reject(new PairError("api-unavailable", `gh api exited ${err.code ?? "error"}`));
        else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new PairError("api-unavailable", "gh api returned non-JSON"));
          }
        }
      });
    });
  return {
    async getPull(repo, number) {
      const pr = await ghJson([`repos/${repo}/pulls/${number}`]);
      return pr;
    },
    async getDefaultSha(repo) {
      const meta = await ghJson([`repos/${repo}`]);
      const branch = String(meta.default_branch ?? "");
      if (!/^[A-Za-z0-9_./-]+$/.test(branch)) {
        throw new PairError("bad-sha", "default branch name is malformed");
      }
      const commit = await ghJson([`repos/${repo}/commits/${branch}`]);
      return commit.sha;
    },
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new PairError("bad-args", `unexpected argument ${key.slice(0, 40)}`);
    out[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const api = ghAdapter();
  if (args["verify-mode"]) {
    // Post-comparison recheck of the frozen heads the workflow resolved earlier.
    // Values come from the workflow's own step outputs and are validated here.
    const mode = args["verify-mode"];
    const counterpartRepo = counterpartOf(args.repo);
    const ownPr = args.pr ? Number(args.pr) : null;
    const counterpartPr = args["verify-counterpart-pr"] ? Number(args["verify-counterpart-pr"]) : null;
    const resolved = {
      mode,
      own: { repo: args.repo, pr: ownPr, sha: args["verify-own-sha"] || null },
      counterpart: { repo: counterpartRepo, pr: counterpartPr, sha: args["verify-counterpart-sha"] },
    };
    if (mode !== "paired" && mode !== "default") throw new PairError("bad-args", "unknown verify mode");
    requireSha(resolved.counterpart.sha, "bad-sha");
    if (resolved.own.pr !== null) requireSha(resolved.own.sha, "bad-sha");
    await recheckFrozen({ api, resolved });
    process.stdout.write("recheck=ok\n");
    return;
  }
  const resolved = await resolvePair({ api, repo: args.repo, pr: args.pr ?? null });
  // Only validated values are written, as key=value lines for $GITHUB_OUTPUT.
  process.stdout.write(
    [
      `mode=${resolved.mode}`,
      `counterpart_repo=${resolved.counterpart.repo}`,
      `counterpart_ref=${resolved.counterpart.sha}`,
      `counterpart_pr=${resolved.counterpart.pr ?? ""}`,
      `own_sha=${resolved.own.sha ?? ""}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    const code = err instanceof PairError ? err.code : "internal";
    process.stderr.write(`drift-pair: FAILED closed (${code})\n`);
    process.exit(1);
  });
}
