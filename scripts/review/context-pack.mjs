// Context pack: definitions of identifiers a diff calls, so the model stops
// flagging correct code whose signature lives in another file.
import { execFileSync } from 'node:child_process';

const MAX_PACK_CHARS = 2000;
const DEFINITION_LINES = 15;
const MAX_IDENTIFIERS = 8;
const IDENTIFIER = /\b([A-Za-z_$][\w$]{3,})\s*\(/g;
const NOISE = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'await', 'async', 'require',
  'fetch', 'JSON', 'parse', 'stringify', 'push', 'map', 'filter', 'then', 'json', 'text', 'join', 'slice', 'includes']);

export function calledIdentifiers(body) {
  const names = new Set();
  for (const line of body.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const m of line.matchAll(IDENTIFIER)) if (!NOISE.has(m[1])) names.add(m[1]);
  }
  return [...names].slice(0, MAX_IDENTIFIERS);
}

function definitionFromDiff(diff, name) {
  const lines = diff.split('\n');
  const re = new RegExp(`(function\\s+${name}\\b|const\\s+${name}\\s*=)`);
  const at = lines.findIndex((l) => l.startsWith('+') && re.test(l));
  if (at < 0) return null;
  return lines.slice(at, at + DEFINITION_LINES).map((l) => l.replace(/^\+/, '')).join('\n');
}

// Looks only in tracked files, matches the exported definition, never writes.
function definitionFromRepo(name, repoRoot) {
  let hit;
  try {
    // `\b` is a PCRE/JS word boundary, not POSIX ERE — `git grep -E` on macOS
    // silently never matches it. Use an explicit non-identifier-or-end class instead.
    hit = execFileSync('git', ['grep', '-n', '-E', `export (async )?(function|const) ${name}([^[:alnum:]_$]|$)`, '--', '*.ts', '*.tsx', '*.mjs'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0];
  } catch { return null; }
  const m = hit?.match(/^([^:]+):(\d+):/);
  if (!m) return null;
  const start = Number(m[2]);
  try {
    return execFileSync('sed', ['-n', `${start},${start + DEFINITION_LINES - 1}p`, m[1]], { cwd: repoRoot, encoding: 'utf8' });
  } catch { return null; }
}

export function buildContextPack(fileBody, fullDiff, repoRoot = process.cwd()) {
  const parts = [];
  let used = 0;
  for (const name of calledIdentifiers(fileBody)) {
    const def = definitionFromDiff(fullDiff, name) ?? definitionFromRepo(name, repoRoot);
    if (!def) continue;
    if (used + def.length > MAX_PACK_CHARS) continue;
    parts.push(def.trimEnd());
    used += def.length;
  }
  return parts.join('\n---\n');
}
