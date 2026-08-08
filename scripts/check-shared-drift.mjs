#!/usr/bin/env node
// Fails if a shared-core file has drifted between nuwrrrld-portal and
// gcp3-mobile beyond the known, documented platform seam (see
// docs/wiki-portal/concept-sync-requirements.md §1). Run in CI after both
// repos are checked out side by side; point WEB_ROOT/MOBILE_ROOT at them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB_ROOT = process.env.WEB_ROOT ?? ".";
const MOBILE_ROOT = process.env.MOBILE_ROOT ?? "../gcp3-mobile";

// path (relative to each repo root) -> normalizer applied to *both* sides
// before comparing. `null` means the two copies must be byte-identical.
const PAIRS = [
  { path: "lib/shared/sse.ts", normalize: null },
  { path: "lib/digest.ts", normalize: null },
  { path: "lib/signalCard.ts", normalize: null },
  { path: "lib/subscription.ts", normalize: null },
  { path: "lib/shared/signalFilters.ts", normalize: stripCommentsAndImports },
  { path: "lib/shared/prefs.ts", normalize: normalizePrefsSeam },
];

function read(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function stripCommentsAndImports(src) {
  return src
    .split("\n")
    .filter((line) => !/^\s*(\/\*|\*|\/\/|import\s)/.test(line))
    .join("\n")
    .trim();
}

// prefs.ts intentionally differs on the localStorage (web) vs.
// expo-secure-store (mobile) storage seam — normalize both sides to a
// placeholder before comparing so only unexpected drift trips the gate.
function normalizePrefsSeam(src) {
  return stripCommentsAndImports(src)
    .replace(/[ \t]*if \(typeof window === "undefined"\) return null;\n/g, "")
    .replace(/[ \t]*if \(typeof window === "undefined"\) return;\n/g, "")
    .replace(/return window\.localStorage\.getItem\(key\);/g, "return STORAGE_GET;")
    .replace(/return await SecureStore\.getItemAsync\(key\);/g, "return STORAGE_GET;")
    .replace(/window\.localStorage\.setItem\(key, value\);/g, "STORAGE_SET;")
    .replace(/await SecureStore\.setItemAsync\(key, value\);/g, "STORAGE_SET;")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

let failed = false;
for (const { path, normalize } of PAIRS) {
  let web, mobile;
  try {
    web = read(WEB_ROOT, path);
    mobile = read(MOBILE_ROOT, path);
  } catch (err) {
    console.error(`✗ ${path}: could not read — ${err.message}`);
    failed = true;
    continue;
  }
  const a = normalize ? normalize(web) : web;
  const b = normalize ? normalize(mobile) : mobile;
  if (a !== b) {
    console.error(`✗ ${path}: web and mobile copies have drifted beyond the known seam`);
    failed = true;
  } else {
    console.log(`✓ ${path}`);
  }
}

if (failed) {
  console.error(
    "\nShared-core drift detected. Reconcile lib/shared (and the mirrored " +
      "lib/*.ts files) between nuwrrrld-portal and gcp3-mobile before merging.",
  );
  process.exit(1);
}
console.log("\nAll shared files in sync.");
