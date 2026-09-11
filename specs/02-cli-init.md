# 02 — `thoughts init`

Status: Draft

## Purpose

Attach the current code repo to a brain and install everything an AI coding tool needs to use it. Idempotent: running it twice is safe and the second run only reports drift.

## Synopsis

```
thoughts init [--brain <url|id>] [--repo-id <id>] [--tools claude-code,codex,pi]
              [--templates builtin|brain|path:<dir>|git:<url>]
              [--skills all|none|<name,...>] [--no-agents] [--no-commands]
              [--integrations github,azure-devops,jira]
              [--yes] [--force] [--dry-run]
```

With no flags, `init` runs an interactive guide. With `--yes` it uses defaults and any values already in `<repo>/.thoughts.yml`.

## Interactive guide structure

The guide is **per-tool sub-guides**, not one long wizard:

1. A short common section: brain, repo id, templates, integrations (steps 1, 2, 4, 6 below).
2. Then one self-contained sub-guide per selected AI tool (claude-code, codex, pi). Each sub-guide explains where its files will go, shows the setup guide for that tool if it is not detected, and asks its own questions (commands, skills, agents). A user can skip a tool's sub-guide and re-run it later with `thoughts init --tools <name>`.
3. A final summary and the initial sync.

Sub-guides are the unit of re-runnability: `thoughts init --tools codex` on an attached repo runs only the codex sub-guide.

`init` always symlinks the **whole** brain, so every repo's thoughts are visible from here. What it registers with the brain is only the code repo you are standing in. Cloning and registering every code repo listed in `brain.yml` on a fresh machine is a separate command, [`thoughts attach-all`](13-cli-attach-all.md).

## Attached, not initialised

A repo whose `.thoughts.yml` is committed but where **this user on this machine** has never run `init` is *attached, not initialised*. It is detected without any marker:

```
attached-not-initialised  :=  <repo>/.thoughts.yml exists
                          AND ( <repo>/thoughts is missing
                             OR is not a symlink
                             OR does not point to ~/.thoughts/brains/<brain-id>
                             OR that brain clone does not exist )
```

Rules:

- **Every other `thoughts` command refuses to run in this state** (exit 5) with the message: `This repo is attached to brain <name> but not initialised on this machine. Run: thoughts init`. Exempt: `init`, `doctor`, `help`, `version`.
- The standard kit tells the assistant the same thing (see [08-standard-kit.md](08-standard-kit.md)): stop, tell the user to run `thoughts init`, do not work around a missing `thoughts/`.
- `init` in this state does **not** ask for brain or repo id; both come from `.thoughts.yml`. It **does** run the tool and integration sub-guides, with the tools already in `.thoughts.yml` pre-selected, so each user chooses their own tools and integrations. `--yes` accepts the pre-selection.
- `.thoughts.yml` `tools` is the **union** of tools any teammate has set up. `init` appends, never removes. Kit files a tool needs that are already committed by a teammate are reported `up-to-date`, not reinstalled.
- Commands run from **inside a brain clone** (a directory with `brain.yml` in its ancestry and no `.thoughts.yml`) operate on that brain directly and need no symlink. This is how `lint`, `search`, and `status` run in CI or from a laptop that has the brain but not the code repos. There is no separate escape hatch; CI does not run `init`.

### Multiple clones and worktrees

- The same repo cloned to several paths on one machine is fine. `repo_id` derives from the remote, so all clones register as the same repo; each path gets its own symlink; global config records every attached path (`attached: [{path, repo_id, brain, initialised_at}]`) so `thoughts doctor` can list them.
- A git worktree has no `thoughts/` symlink because the symlink is gitignored. Use [`thoughts worktree`](14-cli-worktree.md) to create worktrees with the symlink in place. Running `init` inside a bare worktree is also allowed and only creates the symlink.

### Kit version and updates

- `.thoughts.yml` records `kit_version` (the CLI version that last installed the kit).
- The preflight **warns** (does not refuse) when the installed CLI's kit is newer than `kit_version`, and names the fix: `thoughts kit update`.
- Re-running `init` on an initialised repo offers to update outdated kit files per file. `thoughts kit status` and `thoughts kit update` do the same without the guide. See [08-standard-kit.md](08-standard-kit.md#versioning).

### Optional git hooks

`init --hooks`, or the corresponding prompt in the common section, installs `post-checkout` and `post-merge` hooks. They are **opt-in and off by default**.

- If a hook manager is detected (husky, lefthook, pre-commit), `init` adds the hook through it so it is shared with the team via the repo.
- Otherwise the hooks go to `.git/hooks/` on this machine only.
- The hook only prints a banner when the repo is attached-not-initialised or the kit is outdated. It MUST never block a git operation and MUST exit 0.

## Preflight

Before any step: verify the platform is macOS or Linux, `git` is on `PATH`, and the current directory is inside a git work tree. Fail with exit 1 and a one-line reason otherwise. Windows is unsupported in v1 (D4).

## Steps

Each step is a separate, reportable unit. `--dry-run` prints the plan without touching disk.

### 1. Resolve the brain

1. If `<repo>/.thoughts.yml` exists, use its `brain`.
2. Else if `--brain` given, use it.
3. Else prompt: pick from brains in global config, or enter a remote URL, or **create a new brain** (creates an empty repo with `brain.yml`, `index.md`, and zone directories, and offers to push it).
4. Clone to `~/.thoughts/brains/<brain-id>/` if not already present; otherwise fetch.
   - The clone directory MUST be checked **before** step 3 creates anything: if it exists, is non-empty, and holds no `brain.yml`, `init` fails (exit 3) naming the directory and the command that clears it. A run MUST NOT scaffold a new brain and then abort on this.
   - A clone that fails, or that turns out to hold no `brain.yml`, MUST be removed again before `init` exits. Leaving it behind makes every later `init` for that brain fail on the check above.
   - A local `--brain <path>` that is a checked-out git repository without a `brain.yml` MUST be refused before cloning, naming the path the user gave.
5. Install the secret-scanning `pre-commit` hook in the brain clone ([15-secret-scanning.md](15-secret-scanning.md)). This clone is CLI-owned, so the hook is always installed and re-installed if missing; it is not subject to the opt-in rule for code-repo hooks.

### 2. Register the repo

1. Determine `repo_id` (flag → `.thoughts.yml` → git remote name → directory name; confirm interactively).
2. Add to `brain.yml` `repos[]` if missing.
3. Create `<brain>/repos/<repo-id>/{plans,specs,research,decisions,prs}/` with `.gitkeep`.
4. Write `<repo>/.thoughts.yml`.

### 3. Symlink

Create `<repo>/thoughts` → brain root. Add `/thoughts` to `.gitignore`. Rules in [01-brain-repo.md](01-brain-repo.md#symlink-behaviour).

### 4. Templates

Record the template source in `brain.yml` (`templates.source`). If `brain` is chosen and `<brain>/templates/` is empty, copy the built-in templates there so the org can edit them. See [07-templates.md](07-templates.md).

### 5. Standard kit

For each selected tool adapter (see [11-ai-tool-adapters.md](11-ai-tool-adapters.md)):

| Component | Default | Flag to skip |
|-----------|---------|--------------|
| Commands (`/thoughts-plan`, `/thoughts-spec`, `/thoughts-research`, `/thoughts-decide`, `/thoughts-commit`, `/thoughts-pr`, `/thoughts-status`) | installed | `--no-commands` |
| Skills | prompt to choose; `--skills all` / `none` | `--skills` |
| Agents (`agents.md` / tool-specific agent defs) | installed | `--no-agents` |
| Instruction file (`CLAUDE.md`, `AGENTS.md`, etc.) | **merged**, never overwritten | — |

Instruction-file merge rule: `init` inserts a clearly delimited block:

```
<!-- thoughts:begin (managed by `thoughts init`; edit outside this block) -->
...
<!-- thoughts:end -->
```

If the block exists, it is replaced. Content outside the block is untouched. This is the only way `init` edits a user-owned file.

Content of the block is defined in [08-standard-kit.md](08-standard-kit.md).

### 6. Integrations

For each selected integration, run its setup from [10-integrations.md](10-integrations.md). Credentials go to the OS keychain or an env var reference in global config, **never** into the brain or the repo.

### 7. Secret check on written config

Scan `<repo>/.thoughts.yml` and `<brain>/brain.yml` for anything credential-shaped. Integration setup stores credentials in the keychain or as env var references, so a hit here means a bug or a pasted token; `init` refuses to continue and names the line.

### 8. Initial sync and report

Run the equivalent of `thoughts sync` (regenerate indexes, commit, push if remote configured), then print a summary table of what was created / updated / skipped.

## Idempotency and drift

Re-running `init` on an attached repo:

- MUST NOT prompt for anything already answered in `.thoughts.yml` unless `--force`.
- Compares installed kit files against the current kit version and reports `up-to-date`, `modified locally`, or `outdated`. Outdated files are updated only with `--force` or per-file confirmation.
- Never deletes user files.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success (including no-op re-run) |
| 1 | User aborted or validation error |
| 2 | Brain unreachable (clone/fetch failed) |
| 3 | Filesystem conflict (existing `thoughts/` path, unwritable instruction file) |
| 5 | Attached, not initialised (emitted by every command except `init`, `doctor`, `help`, `version`) |
| 7 | Secret found in config being written |

## Acceptance criteria

- Fresh repo + new brain → after `init`, `ls thoughts/repos/<id>` shows the kind dirs and `git -C thoughts log` shows an initial commit.
- Second teammate clones the repo, runs `thoughts init --yes` → attaches to the same brain with no prompts.
- Existing `CLAUDE.md` with custom content → after `init`, custom content is byte-identical outside the managed block.
- `--dry-run` writes nothing (verified by `git status` in both repos and absence of symlink).
- Fresh clone of an attached repo, then `thoughts status` → exit 5 with the init message; `thoughts init` skips brain/repo-id prompts and runs the tool sub-guides; `status` then works.
- Same repo cloned to two paths → both symlinks valid, `doctor` lists both under one `repo_id`.
- Older `kit_version` in `.thoughts.yml` → every command prints one warning naming `thoughts kit update`; nothing refuses.
- `git checkout` in a hooked, uninitialised clone → banner printed, checkout succeeds.

## Open questions

- None.
