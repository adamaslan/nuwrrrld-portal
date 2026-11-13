// Contract test for the INERT activation templates. Reads text only; never runs them.
// Run: node --test scripts/drift-pair/activation.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Each repo carries exactly one template (job for web, workflow for mobile).
const TEMPLATES = readdirSync(join(here, "activation"))
  .filter((f) => f.endsWith(".yml"))
  .map((f) => join(here, "activation", f));
// Flags the revised resolver CLI actually accepts.
const SUPPORTED_FLAGS = new Set(["--repo", "--pr", "--event-head-sha", "--expect-binding"]);

for (const path of TEMPLATES) {
  const name = path.split("/").pop();
  const text = readFileSync(path, "utf8");

  test(`${name}: is inert and says so`, () => {
    assert.match(text, /INERT TEMPLATE\. NOT APPLIED\. NOT ACTIVE\./);
  });

  test(`${name}: uses no obsolete --verify-* flags`, () => {
    assert.doesNotMatch(text, /--verify-/);
  });

  test(`${name}: every resolver flag is a supported one`, () => {
    const flags = [...text.matchAll(/resolve-pair\.mjs([^\n]*)/g)]
      .flatMap((m) => [...m[1].matchAll(/--[a-z-]+/g)].map((f) => f[0]));
    assert.ok(flags.length > 0, "template must invoke the resolver");
    for (const f of flags) assert.ok(SUPPORTED_FLAGS.has(f), `unsupported flag ${f}`);
    assert.ok(flags.includes("--event-head-sha"));
    assert.ok(flags.includes("--expect-binding"));
  });

  test(`${name}: PR head checkout is pinned to the event head SHA`, () => {
    assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  });

  test(`${name}: persists no credentials and runs the trusted resolver from base`, () => {
    assert.doesNotMatch(text, /persist-credentials: true/);
    assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
    assert.match(text, /trusted\/scripts\/drift-pair\/resolve-pair\.mjs/);
  });
}

test("a full-workflow template, when present, includes the edited trigger", (t) => {
  const wf = TEMPLATES.filter((p) => p.endsWith(".workflow.yml"));
  if (wf.length === 0) return t.skip("web repo carries a job template; trigger lives in ci.yml");
  assert.match(readFileSync(wf[0], "utf8"), /types: \[opened, synchronize, reopened, edited\]/);
});
