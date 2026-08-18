# How to Run Scripts in Terminal

## The Basics

Open Terminal (or the VS Code integrated terminal), navigate to the project, and run the script.

```bash
cd ~/code/nuwrrrld-portal
```

---

## VS Code: Integrated Terminal

Open the terminal panel without leaving the editor:

| Action | Shortcut |
|--------|----------|
| Open terminal | `` Ctrl+` `` |
| New terminal tab | `Ctrl+Shift+` `` |
| Split terminal | `Ctrl+Shift+5` |
| Focus editor | `Ctrl+1` |
| Focus terminal | `` Ctrl+` `` |

The terminal opens at the workspace root automatically — no `cd` needed.

### Run a Script Directly from the Explorer

Right-click any `.sh` or `.mjs` file in the Explorer sidebar → **Open in Integrated Terminal**, then run it. Or install the **"Run in Terminal"** extension to add a right-click → Run option.

### NPM Scripts Sidebar

VS Code has a built-in **NPM Scripts** panel:

1. Open Explorer (`Ctrl+Shift+E`)
2. Scroll to **NPM SCRIPTS** at the bottom
3. Click the ▶ play button next to any script to run it instantly

---

## VS Code: Tasks (run scripts with a keybind)

Create `.vscode/tasks.json` to bind scripts to keyboard shortcuts.

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Sync E2E Secrets",
      "type": "shell",
      "command": "bash scripts/sync-e2e-secrets.sh",
      "group": "build",
      "presentation": { "reveal": "always", "panel": "shared" }
    },
    {
      "label": "Run Nulogdash",
      "type": "shell",
      "command": "node scripts/nulogdash.mjs",
      "group": "build",
      "presentation": { "reveal": "always", "panel": "shared" }
    }
  ]
}
```

Run any task: `Cmd+Shift+P` → **Tasks: Run Task** → pick from the list.

To bind a task to a key, add to `keybindings.json` (`Cmd+Shift+P` → **Open Keyboard Shortcuts JSON**):

```json
{
  "key": "cmd+shift+s",
  "command": "workbench.action.tasks.runTask",
  "args": "Sync E2E Secrets"
}
```

---

## Shell Scripts (.sh)

```bash
bash scripts/sync-e2e-secrets.sh
# or make it directly executable first:
chmod +x scripts/sync-e2e-secrets.sh
./scripts/sync-e2e-secrets.sh
```

## Node Scripts (.mjs)

```bash
node scripts/nulogdash.mjs
node scripts/refresh-free-models.mjs
node scripts/db-migrate.mjs
```

---

## Project Scripts (package.json)

```bash
npm run dev          # start dev server
npm run build        # production build
npm run test         # run tests
npm run              # list all available scripts
```

In VS Code, these also appear in the **NPM Scripts** sidebar panel — click ▶ to run without typing.

---

## Running From Anywhere (no cd needed)

Use an absolute path:
```bash
bash ~/code/nuwrrrld-portal/scripts/sync-e2e-secrets.sh
```

Or add an alias to `~/.zshrc`:
```bash
alias sync-secrets="bash ~/code/nuwrrrld-portal/scripts/sync-e2e-secrets.sh"
```

Reload:
```bash
source ~/.zshrc
```

Now `sync-secrets` works in any terminal, including VS Code's.

---

## Inside Claude Code (this session)

Prefix any command with `!` to run it directly in the conversation:

```
! bash scripts/sync-e2e-secrets.sh
! node scripts/nulogdash.mjs
```

---

## Common Patterns

| Task | Command |
|------|---------|
| Run a shell script | `bash scripts/foo.sh` |
| Run a node script | `node scripts/foo.mjs` |
| Make a script executable | `chmod +x scripts/foo.sh` |
| Run with env var | `MY_VAR=value bash scripts/foo.sh` |
| Suppress output | `bash scripts/foo.sh > /dev/null 2>&1` |
| Save output to file | `bash scripts/foo.sh > out.txt` |
| Run as VS Code task | `Cmd+Shift+P` → Tasks: Run Task |

---

## Available Scripts in This Project

| Script | How to run | What it does |
|--------|-----------|-------------|
| `sync-e2e-secrets.sh` | `bash scripts/sync-e2e-secrets.sh` | Sync E2E test secrets to local env |
| `run-refresh-remote.sh` | `bash scripts/run-refresh-remote.sh` | Trigger remote model refresh |
| `nulogdash.mjs` | `node scripts/nulogdash.mjs` | Run the nulogdash dashboard tool |
| `refresh-free-models.mjs` | `node scripts/refresh-free-models.mjs` | Refresh the free model chain |
| `db-migrate.mjs` | `node scripts/db-migrate.mjs` | Run database migrations |
| `hydrate-dev.mjs` | `node scripts/hydrate-dev.mjs` | Seed dev environment data |
| `check-shared-drift.mjs` | `node scripts/check-shared-drift.mjs` | Check for shared module drift |
| `stash-status.mjs` | `node scripts/stash-status.mjs` | Show git stash status |
| `compile_grounding_pack.mjs` | `node scripts/compile_grounding_pack.mjs` | Compile grounding context pack |
| `grounding-chunker.mjs` | `node scripts/grounding-chunker.mjs` | Chunk grounding data |
| `nulogdash-inventory.mjs` | `node scripts/nulogdash-inventory.mjs` | Inventory nulogdash resources |
| `nulogdash-merge-e2e.mjs` | `node scripts/nulogdash-merge-e2e.mjs` | Merge E2E results into nulogdash |
