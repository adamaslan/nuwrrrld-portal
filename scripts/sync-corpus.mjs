#!/usr/bin/env node
/**
 * sync-corpus — mirror the curated trader Q&A corpus from the public
 * adamaslan/ai-text-opt repo (docs/trader-qa/*.md) into corpus/trader-qa/.
 *
 * ai-text-opt stays where the corpus is written; this repo admits it through
 * a reviewed PR (.github/workflows/sync-corpus.yml opens one when anything
 * changed). Merging that PR triggers the grounding compile, which re-extracts
 * only new or changed chunks.
 *
 * Files about the RAG tooling rather than trading are excluded — they would
 * compile into "evidence" about pipelines, not markets. A file removed
 * upstream is removed here too (git history keeps it; the PR shows it).
 *
 * Zero deps, native fetch. GITHUB_TOKEN is optional (raises the API rate
 * limit); the source repo is public.
 *
 * Exit codes: 0 = success (changed or not), 1 = fetch/IO failure.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_REPO = "adamaslan/ai-text-opt";
const SOURCE_DIR = "docs/trader-qa";
const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TARGET_DIR = join(repoRoot, "corpus", "trader-qa");

/** Outlines, previews, and RAG-tooling notes — not trading content. */
export const EXCLUDED_FILES = new Set([
  "00-theme-outline.md",
  "REMAINING-QA-OUTLINE.md",
  "vde-xle-war-end-outline.md",
  "doc-2-industries-and-sectors-PREVIEW.md",
  "llamaindex-zilliz-rag-pipeline.md",
  "zilliz-rag-pipeline-outline.md",
]);

function githubHeaders(accept) {
  const headers = { Accept: accept, "User-Agent": "nuwrrrld-portal-sync-corpus" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function listSourceFiles() {
  const url = `https://api.github.com/repos/${SOURCE_REPO}/contents/${SOURCE_DIR}`;
  const res = await fetch(url, { headers: githubHeaders("application/vnd.github+json") });
  if (!res.ok) throw new Error(`listing ${SOURCE_REPO}/${SOURCE_DIR} failed: HTTP ${res.status}`);
  const entries = await res.json();
  return entries
    .filter((e) => e.type === "file" && e.name.endsWith(".md") && !EXCLUDED_FILES.has(e.name))
    .map((e) => e.path);
}

async function fetchRaw(path) {
  const url = `https://api.github.com/repos/${SOURCE_REPO}/contents/${path}`;
  const res = await fetch(url, { headers: githubHeaders("application/vnd.github.raw") });
  if (!res.ok) throw new Error(`fetching ${path} failed: HTTP ${res.status}`);
  return res.text();
}

async function readIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function main() {
  const sourcePaths = await listSourceFiles();
  if (!sourcePaths.length) {
    // An empty listing is far more likely a moved directory than a deleted
    // corpus; refuse rather than mirror the emptiness into a delete-everything PR.
    throw new Error(`no includable .md files under ${SOURCE_REPO}/${SOURCE_DIR}`);
  }
  await mkdir(TARGET_DIR, { recursive: true });

  const wanted = new Set();
  let written = 0;
  for (const path of sourcePaths) {
    const name = path.split("/").pop();
    wanted.add(name);
    const text = await fetchRaw(path);
    const target = join(TARGET_DIR, name);
    if ((await readIfExists(target)) === text) continue;
    await writeFile(target, text);
    written++;
    console.log(`  updated ${name}`);
  }

  let removed = 0;
  for (const name of await readdir(TARGET_DIR)) {
    if (name.endsWith(".md") && !wanted.has(name)) {
      await rm(join(TARGET_DIR, name));
      removed++;
      console.log(`  removed ${name} (gone upstream or now excluded)`);
    }
  }

  console.log(`sync-corpus: ${sourcePaths.length} source file(s), ${written} updated, ${removed} removed`);
}

main().catch((err) => {
  console.error(`sync-corpus failed: ${err.message}`);
  process.exit(1);
});
