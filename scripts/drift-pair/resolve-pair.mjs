#!/usr/bin/env node
// Trusted paired-drift resolver for the shared-core drift gate.
//
// Decides which counterpart commit the drift check compares against:
//   - an UNPAIRED PR (or a PR whose counterpart has MERGED) compares against
//     the counterpart repo's current default branch, with the full comparator;
//   - a PAIRED PR compares against the counterpart PR's exact head SHA. Pairing
//     requires reciprocal `drift-pair:` references AND reciprocal exact-SHA pins
//     (`drift-pair-sha:`) that match both live heads.
// A pair that is requested but invalid, unavailable, non-reciprocal or whose
// counterpart is CLOSED WITHOUT MERGE fails closed. It never silently skips.
//
// Binding: the resolver returns a `binding` digest over the complete resolved
// identity (mode, repos, PR numbers, head SHAs, and every pair/pin line in both
// bodies). A caller that re-runs resolution after comparison and gets a
// different binding must fail. This catches a removed back-reference or pin.
//
// Trust boundary: this file is trusted code, loaded from the BASE branch by the
// workflow. All PR metadata (bodies, refs, titles) is untrusted data. It is
// matched with strict patterns, never executed, never placed in a shell string
// and never used as a path. No secrets, no privileged event, no counterpart code.
//
// Stdlib only (node >= 20). The API is injectable so the logic is testable
// without network access; see resolve-pair.test.mjs.

import { createHash } from "node:crypto";
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
const PAIR_LINE_RE =
  /^drift-pair:[ \t]*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,6})[ \t]*$/gm;
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

/** Every pair/pin line, normalized, in order. Used for the binding digest. */
function bindingLines(text) {
  const out = [];
  for (const re of [PAIR_LINE_RE, PIN_LINE_RE]) {
    for (const m of String(text ?? "").matchAll(re)) out.push(m[0].trim());
  }
  return out.sort();
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
  const merged = raw.merged === true;
  return {
    number,
    repo,
    state: raw.state,
    merged,
    mergedAt: raw.merged_at ?? null,
    mergeCommitSha: raw.merge_commit_sha ?? null,
    draft: raw.draft === true,
    body: typeof raw.body === "string" ? raw.body : "",
    baseRef: raw.base?.ref ?? null,
    baseRepo: raw.base?.repo?.full_name ?? null,
    headRef: raw.head?.ref ?? null,
    headRepo: raw.head?.repo?.full_name ?? null,
    headSha: requireSha(raw.head?.sha, "bad-sha"),
  };
}

function assertOpenSameRepoMain(pull, label, code) {
  if (pull.state !== "open" || pull.merged) {
    throw new PairError(code, `${label} PR #${pull.number} is not open`);
  }
  if (pull.headRepo !== pull.repo) {
    throw new PairError("fork", `${label} PR #${pull.number} head is not in ${pull.repo}`);
  }
  if (pull.baseRepo !== pull.repo || pull.baseRef !== "main") {
    throw new PairError("wrong-base", `${label} PR #${pull.number} does not target main`);
  }
}

function summaryOf(resolved) {
  return JSON.stringify({
    mode: resolved.mode,
    reason: resolved.reason,
    own: resolved.own,
    counterpart: resolved.counterpart,
    ownBinding: resolved.ownBinding,
    counterpartBinding: resolved.counterpartBinding,
  });
}

/** Digest over the complete resolved identity. Stable across runs when nothing moved. */
export function bindingOf(resolved) {
  return createHash("sha256").update(summaryOf(resolved)).digest("hex");
}

/**
 * Resolve the counterpart to compare against.
 *
 * @param {object} args
 * @param {object} args.api        { getPull(repo, n), getDefaultSha(repo) }
 * @param {string} args.repo       owner/name of the repository running the gate
 * @param {string|number|null} [args.pr]  PR number, or null for a push run
 * @param {string|null} [args.eventHeadSha]  head SHA the triggering event carried
 */
export async function resolvePair({ api, repo, pr = null, eventHeadSha = null }) {
  requireRepo(repo, "bad-repo");
  const counterparty = counterpartOf(repo);
  if (!counterparty) {
    throw new PairError("not-allowlisted", `${repo} is not in ALLOWED_PAIRS`);
  }

  if (pr === null || pr === undefined || pr === "") {
    // Push run: default branches only. No PR metadata exists to bind.
    const sha = requireSha(await safeDefaultSha(api, counterparty), "bad-sha");
    return finish({
      mode: "default",
      reason: "push",
      own: { repo, pr: null, sha: null },
      counterpart: { repo: counterparty, pr: null, sha },
      ownBinding: "",
      counterpartBinding: "",
    });
  }

  const prText = String(pr);
  if (!PR_NUMBER_RE.test(prText)) {
    throw new PairError("bad-pr-number", "PR number is not a positive integer");
  }
  const ownNumber = Number(prText);
  const own = checkedPull(await safeGetPull(api, repo, ownNumber), repo, ownNumber, "own");
  assertOpenSameRepoMain(own, "own", "own-state");
  if (eventHeadSha !== null) {
    // Bind the live head to the head the event carried. Mismatch means stale or
    // moved input: refuse rather than check something else.
    requireSha(eventHeadSha, "bad-sha");
    if (own.headSha !== eventHeadSha) {
      throw new PairError("event-head-mismatch", "live own head differs from the event head");
    }
  }

  const pairMatch = singleMatch(PAIR_LINE_RE, own.body);
  const ownBinding = bindingLines(own.body).join("\n");
  if (!pairMatch) {
    const sha = requireSha(await safeDefaultSha(api, counterparty), "bad-sha");
    return finish({
      mode: "default",
      reason: "unpaired",
      own: { repo, pr: ownNumber, sha: own.headSha },
      counterpart: { repo: counterparty, pr: null, sha },
      ownBinding,
      counterpartBinding: "",
    });
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

  // Lifecycle: a MERGED counterpart is no longer a pending pair. Compare against
  // its current default branch with the full comparator. A merged PR must carry
  // consistent merge fields; closed-without-merge is refused.
  if (counter.merged) {
    if (counter.state !== "closed" || !counter.mergedAt || !counter.mergeCommitSha) {
      throw new PairError("bad-merge-state", "counterpart merge fields are inconsistent");
    }
    const sha = requireSha(await safeDefaultSha(api, counterparty), "bad-sha");
    return finish({
      mode: "default",
      reason: "counterpart-merged",
      own: { repo, pr: ownNumber, sha: own.headSha },
      counterpart: { repo: counterparty, pr: counterNumber, sha },
      ownBinding,
      counterpartBinding: bindingLines(counter.body).join("\n"),
    });
  }
  assertOpenSameRepoMain(counter, "counterpart", "counterpart-state");

  // Reciprocity: the counterpart must name this PR back, exactly once.
  const back = singleMatch(PAIR_LINE_RE, counter.body);
  if (!back || back[1] !== repo || back[2] !== String(ownNumber)) {
    throw new PairError("nonreciprocal", "counterpart PR does not reference this PR back");
  }

  // Exact-SHA pins are REQUIRED for a pair, on both sides, and must match the
  // live heads. Pins live in PR bodies (metadata), never in commit contents.
  const ownPin = singleMatch(PIN_LINE_RE, own.body);
  const counterPin = singleMatch(PIN_LINE_RE, counter.body);
  if (!ownPin || !counterPin) {
    throw new PairError("pin-required", "both PR bodies must carry a drift-pair-sha pin");
  }
  if (ownPin[1] !== counterparty || ownPin[2] !== counter.headSha) {
    throw new PairError("pin-mismatch", "own pin does not match the counterpart live head");
  }
  if (counterPin[1] !== repo || counterPin[2] !== own.headSha) {
    throw new PairError("pin-mismatch", "counterpart pin does not match this PR's live head");
  }

  return finish({
    mode: "paired",
    reason: "reciprocal-pin",
    own: { repo, pr: ownNumber, sha: own.headSha },
    counterpart: { repo: counterparty, pr: counterNumber, sha: counter.headSha },
    ownBinding,
    counterpartBinding: bindingLines(counter.body).join("\n"),
  });
}

function finish(resolved) {
  return { ...resolved, binding: bindingOf(resolved) };
}

/**
 * Post-comparison recheck. Re-runs the full resolution from live state and
 * requires the identical binding. Any moved head, edited or removed pin or
 * back-reference, lifecycle change or closed counterpart fails here.
 */
export async function recheckFrozen({ api, resolved, eventHeadSha = null }) {
  const again = await resolvePair({
    api,
    repo: resolved.own.repo,
    pr: resolved.own.pr,
    eventHeadSha,
  });
  if (again.binding !== resolved.binding) {
    throw new PairError("binding-changed", "resolved identity changed during comparison");
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

/** Live adapter over the `gh` CLI. Arguments are an array, never a shell string. */
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
      return ghJson([`repos/${repo}/pulls/${number}`]);
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
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key || !key.startsWith("--")) {
      throw new PairError("bad-args", "arguments must be --name value pairs");
    }
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  const api = ghAdapter();
  const resolved = await resolvePair({
    api,
    repo: args.repo,
    pr: args.pr ?? null,
    eventHeadSha: args["event-head-sha"] ?? null,
  });
  if (args["expect-binding"]) {
    // Final re-resolution in the workflow: the binding must be unchanged.
    await recheckFrozen({ api, resolved, eventHeadSha: args["event-head-sha"] ?? null });
    if (resolved.binding !== args["expect-binding"]) {
      throw new PairError("binding-changed", "binding differs from the frozen value");
    }
    process.stdout.write("recheck=ok\n");
    return;
  }
  // Only validated values are written, as key=value lines for $GITHUB_OUTPUT.
  process.stdout.write(
    [
      `mode=${resolved.mode}`,
      `reason=${resolved.reason}`,
      `counterpart_repo=${resolved.counterpart.repo}`,
      `counterpart_ref=${resolved.counterpart.sha}`,
      `counterpart_pr=${resolved.counterpart.pr ?? ""}`,
      `own_sha=${resolved.own.sha ?? ""}`,
      `binding=${resolved.binding}`,
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
