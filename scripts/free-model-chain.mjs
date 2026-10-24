#!/usr/bin/env node
/**
 * Read and diff FREE_MODEL_CHAIN from lib/openrouter.ts.
 *
 * Shared by the weekly refresh workflow (added/removed ids for alerts) and the
 * read-only health check (the committed chain to re-verify). Pure functions
 * are exported; running the file directly prints a JSON diff:
 *
 *   node scripts/free-model-chain.mjs old.ts new.ts
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CHAIN_PATTERN = /export const FREE_MODEL_CHAIN = \[([\s\S]*?)\]\s*as const/;
const MODEL_ID_PATTERN = /'([^']+)'/g;

/**
 * Parse the ids in FREE_MODEL_CHAIN, in order.
 * Throws when the array cannot be found, so a renamed or reformatted export
 * fails loudly instead of reporting an empty chain as "no change".
 */
export function parseChain(source) {
  const match = CHAIN_PATTERN.exec(source);
  if (!match) throw new Error('FREE_MODEL_CHAIN array not found in source');
  const ids = [...match[1].matchAll(MODEL_ID_PATTERN)].map((m) => m[1]);
  if (ids.length === 0) throw new Error('FREE_MODEL_CHAIN parsed to zero ids');
  return ids;
}

/** Ids present in `next` but not `previous`, and the reverse, both in order. */
export function diffChains(previous, next) {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    changed: previous.length !== next.length || previous.some((id, i) => id !== next[i]),
    added: next.filter((id) => !before.has(id)),
    removed: previous.filter((id) => !after.has(id)),
    chain: next,
  };
}

/** Compare two source files, the way the workflow does. */
export function diffChainFiles(oldPath, newPath) {
  return diffChains(
    parseChain(readFileSync(oldPath, 'utf8')),
    parseChain(readFileSync(newPath, 'utf8')),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error('usage: node scripts/free-model-chain.mjs <old-openrouter.ts> <new-openrouter.ts>');
    process.exit(2);
  }
  console.log(JSON.stringify(diffChainFiles(oldPath, newPath)));
}
