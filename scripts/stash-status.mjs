/**
 * Renders docs/stash-status.html — a snapshot of `git stash list` plus, for
 * each stash, whether it's still untouched, applied-but-not-dropped, or
 * gone, and what tracked/untracked paths it carries. Exists because a stash
 * holding real feature work (see docs/wiki-portal/incident-2026-08-*) is
 * invisible in `git status` once applied — this makes "is it safe to drop
 * yet" a glance instead of a git-archaeology session.
 *
 *   node scripts/stash-status.mjs
 *
 * Output is gitignored (see .gitignore) — it's a regenerable local report,
 * not source of truth. Re-run any time the stash list changes.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const OUT_FILE = join(ROOT, "docs", "stash-status.html");
const MAX_FILES_SHOWN = 40;

function git(args, opts = {}) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
  } catch (err) {
    if (opts.allowFail) return "";
    throw err;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Gather stash entries
// ---------------------------------------------------------------------------
function listStashes() {
  const raw = git(["stash", "list", "--pretty=format:%gd%x09%H%x09%gs"], { allowFail: true });
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [ref, sha, subject] = line.split("\t");
    return { ref, sha, subject };
  });
}

function stashFiles(ref) {
  // Tracked-file changes (parent 1 vs parent 2).
  const tracked = git(["diff", "--name-status", `${ref}^1`, `${ref}^2`], { allowFail: true })
    .split("\n").filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });

  // Untracked files live in a third stash parent only when the stash was
  // made with `-u`/`-a`; ^3 simply doesn't resolve otherwise.
  let untracked = [];
  const hasUntrackedParent = git(["rev-parse", "--verify", "-q", `${ref}^3`], { allowFail: true });
  if (hasUntrackedParent) {
    untracked = git(["ls-tree", "-r", "--name-only", `${ref}^3`], { allowFail: true })
      .split("\n").filter(Boolean)
      .map((path) => ({ status: "U", path }));
  }

  return { tracked, untracked, hasUntrackedParent: Boolean(hasUntrackedParent) };
}

function stashBaseBranch(ref) {
  // `stash@{N}: WIP on <branch>: <sha> <msg>` — branch name is the reliable part.
  const subject = git(["stash", "list", "--pretty=format:%gs", "-1", ref], { allowFail: true });
  const match = subject.match(/^(?:WIP on|On) ([^:]+):/);
  return match ? match[1] : "unknown";
}

function currentBranch() {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true }) || "unknown";
}

function branchExists(name) {
  return Boolean(git(["rev-parse", "--verify", "-q", name], { allowFail: true }));
}

function worktreeIsClean() {
  const status = git(["status", "--porcelain"], { allowFail: true });
  return status.length === 0;
}

// ---------------------------------------------------------------------------
// Build the report
// ---------------------------------------------------------------------------
function buildReport() {
  const stashes = listStashes();
  const branch = currentBranch();
  const clean = worktreeIsClean();

  const entries = stashes.map((stash) => {
    const { tracked, untracked, hasUntrackedParent } = stashFiles(stash.ref);
    const baseBranch = stashBaseBranch(stash.ref);
    const baseBranchStillExists = baseBranch !== "unknown" ? branchExists(baseBranch) : false;
    return {
      ...stash,
      baseBranch,
      baseBranchStillExists,
      tracked,
      untracked,
      hasUntrackedParent,
      totalFiles: tracked.length + untracked.length,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    currentBranch: branch,
    worktreeClean: clean,
    stashCount: entries.length,
    stashes: entries,
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function statusBadge(status) {
  const map = { A: "added", M: "modified", D: "deleted", U: "untracked" };
  const cls = { A: "ok", M: "warn", D: "gap", U: "info" }[status] ?? "info";
  return `<span class="badge badge--${cls}">${map[status] ?? status}</span>`;
}

function renderFileList(files) {
  if (files.length === 0) return `<p class="empty">None.</p>`;
  const shown = files.slice(0, MAX_FILES_SHOWN);
  const rest = files.length - shown.length;
  return `
    <ul class="file-list">
      ${shown.map((f) => `<li>${statusBadge(f.status)}<code>${escapeHtml(f.path)}</code></li>`).join("\n      ")}
    </ul>
    ${rest > 0 ? `<p class="more">+ ${rest} more file${rest === 1 ? "" : "s"}</p>` : ""}
  `;
}

function renderStashCard(entry, index) {
  const branchNote = entry.baseBranchStillExists
    ? `<span class="badge badge--ok">branch present</span>`
    : `<span class="badge badge--gap">branch gone — recreate from base sha first</span>`;

  return `
  <article class="stash-card">
    <header class="stash-card__head">
      <div>
        <h3>${escapeHtml(entry.ref)}</h3>
        <p class="subject">${escapeHtml(entry.subject)}</p>
      </div>
      <div class="stash-card__meta">
        <span class="badge badge--info">${entry.totalFiles} file${entry.totalFiles === 1 ? "" : "s"}</span>
        ${branchNote}
      </div>
    </header>
    <dl class="kv">
      <dt>Base branch</dt><dd><code>${escapeHtml(entry.baseBranch)}</code></dd>
      <dt>Commit</dt><dd><code>${escapeHtml(entry.sha.slice(0, 12))}</code></dd>
      <dt>Untracked payload</dt><dd>${entry.hasUntrackedParent ? "yes — stashed with -u" : "no"}</dd>
    </dl>
    <details ${index === 0 ? "open" : ""}>
      <summary>Tracked changes (${entry.tracked.length})</summary>
      ${renderFileList(entry.tracked)}
    </details>
    <details ${index === 0 && entry.untracked.length > 0 ? "open" : ""}>
      <summary>Untracked files carried (${entry.untracked.length})</summary>
      ${renderFileList(entry.untracked)}
    </details>
  </article>`;
}

function render(report) {
  const worktreeBadge = report.worktreeClean
    ? `<span class="badge badge--ok">clean</span>`
    : `<span class="badge badge--warn">has local changes</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Stash status — nuwrrrld-portal</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{
  --bg:#f7f5f1; --surface:#ffffff; --border:#e3ddd1; --ink:#241f18;
  --ink-soft:#5c5346; --muted:#8a8171; --accent:#a8471e; --ok:#3d6b4c;
  --ok-bg:#e6efe6; --warn:#9c6b1f; --warn-bg:#f5ecd9; --gap:#b23b3b;
  --gap-bg:#f7e4e0; --info:#3d5a80; --info-bg:#e3ecf5; --mono-bg:#efe9dd;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#1c1913; --surface:#26221a; --border:#3a352a; --ink:#efe9dd;
    --ink-soft:#c4bcac; --muted:#8f8877; --accent:#e08a54; --ok:#7fb894;
    --ok-bg:#20302a; --warn:#d9b063; --warn-bg:#332a19; --gap:#e08585;
    --gap-bg:#332120; --info:#8fb2d9; --info-bg:#20293a; --mono-bg:#211e17;
  }
}
*{box-sizing:border-box;}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.55;}
.wrap{max-width:900px;margin:0 auto;padding:3rem 1.5rem 5rem;}
header.masthead{border-bottom:2px solid var(--ink);padding-bottom:1.5rem;margin-bottom:2rem;}
.eyebrow{font-family:ui-monospace,'SF Mono',Consolas,monospace;font-size:0.75rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--accent);margin-bottom:0.6rem;}
h1{font-size:1.9rem;margin:0 0 0.5rem;}
.dek{color:var(--ink-soft);margin:0 0 1rem;max-width:60ch;}
.meta-row{display:flex;flex-wrap:wrap;gap:0.5rem 1.25rem;font-family:ui-monospace,monospace;font-size:0.8rem;color:var(--muted);align-items:center;}
.badge{display:inline-block;font-family:ui-monospace,monospace;font-size:0.72rem;padding:0.15rem 0.55rem;border-radius:999px;white-space:nowrap;}
.badge--ok{background:var(--ok-bg);color:var(--ok);}
.badge--warn{background:var(--warn-bg);color:var(--warn);}
.badge--gap{background:var(--gap-bg);color:var(--gap);}
.badge--info{background:var(--info-bg);color:var(--info);}
.empty-state{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:2rem;text-align:center;color:var(--ink-soft);}
.stash-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.5rem;margin-bottom:1.25rem;}
.stash-card__head{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start;margin-bottom:1rem;}
.stash-card__meta{display:flex;gap:0.5rem;flex-wrap:wrap;}
.stash-card h3{margin:0 0 0.25rem;font-family:ui-monospace,monospace;font-size:1.05rem;color:var(--accent);}
.subject{margin:0;color:var(--ink-soft);font-size:0.9rem;}
dl.kv{display:grid;grid-template-columns:auto 1fr;gap:0.35rem 1rem;margin:0 0 1rem;font-size:0.88rem;}
dl.kv dt{color:var(--muted);font-family:ui-monospace,monospace;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.04em;align-self:center;}
dl.kv dd{margin:0;color:var(--ink-soft);}
details{border-top:1px solid var(--border);padding-top:0.6rem;margin-top:0.6rem;}
summary{cursor:pointer;font-weight:600;font-size:0.9rem;color:var(--ink);}
.file-list{list-style:none;margin:0.6rem 0 0;padding:0;display:grid;gap:0.35rem;max-height:320px;overflow-y:auto;}
.file-list li{display:flex;gap:0.6rem;align-items:baseline;font-size:0.85rem;}
.file-list code{font-family:ui-monospace,monospace;background:var(--mono-bg);padding:0.05rem 0.35rem;border-radius:3px;color:var(--ink);word-break:break-all;}
.more,.empty{color:var(--muted);font-size:0.82rem;margin:0.4rem 0 0;}
code{font-family:ui-monospace,monospace;}
footer{border-top:1px solid var(--border);margin-top:2.5rem;padding-top:1rem;font-family:ui-monospace,monospace;font-size:0.76rem;color:var(--muted);}
</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <div class="eyebrow">git stash · nuwrrrld-portal</div>
    <h1>Stash status</h1>
    <p class="dek">Generated locally by <code>scripts/stash-status.mjs</code> — regenerate any time with <code>npm run stash:status</code>. This file is gitignored; it's a snapshot, not a record.</p>
    <div class="meta-row">
      <span>Generated <b>${escapeHtml(report.generatedAt)}</b></span>
      <span>Current branch <b>${escapeHtml(report.currentBranch)}</b></span>
      <span>Worktree ${worktreeBadge}</span>
      <span><b>${report.stashCount}</b> stash${report.stashCount === 1 ? "" : "es"}</span>
    </div>
  </header>

  ${report.stashes.length === 0
    ? `<div class="empty-state">No stashes. Nothing to track.</div>`
    : report.stashes.map(renderStashCard).join("\n")}

  <footer>
    Run <code>node scripts/stash-status.mjs</code> to refresh. Applying a stash with <code>git stash apply</code> keeps it listed here until you <code>git stash drop</code> it — cross-check <code>git status</code> before dropping.
  </footer>
</div>
</body>
</html>`;
}

function main() {
  const report = buildReport();
  writeFileSync(OUT_FILE, render(report));
  console.log(`stash-status: ${report.stashCount} stash(es) → ${OUT_FILE}`);
}

main();
