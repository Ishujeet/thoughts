# 12 — Open decisions

Status: Living

Decisions that need a human call. Decided rows stay here as the decision log until they are moved into `decision` thoughts in the project's own brain. Undecided rows carry a recommendation so work can proceed under an assumption if no one objects.

## Decided (2026-09-08)

| # | Decision | Outcome | Where it lands |
|---|----------|---------|----------------|
| D1 | Implementation language | **TypeScript on Node.js.** Single CLI package, ESM, strict TS. Minimum Node LTS pinned in `package.json` `engines`. | CLAUDE.md |
| D2 | Templating syntax | **Handlebars**, restricted to `{{var}}`, `{{#if}}`, `{{#each}}`, and a small allow-listed helper set. Templates must remain readable as plain markdown by non-developers. | [07-templates.md](07-templates.md) |
| D3 | Brain scope | **One brain per project** in v1. Layout and config carry a `kind` field so an org-level brain holding multiple project brains can be added later without breaking v1 brains. | [01-brain-repo.md](01-brain-repo.md) |
| D4 | Platforms | **macOS and Linux** in v1. Windows is unsupported; `init` exits with a clear message. | [01](01-brain-repo.md), [02](02-cli-init.md) |
| D5 | CLI calling an LLM | **Never.** The CLI arranges files; the assistants bring the models. Not "not yet" — a design constraint. | [00-overview.md](00-overview.md) |
| D6 | Search backend | **Both grep and SQLite FTS, user-selectable.** Default `auto`: SQLite if it loads, otherwise grep. Any SQLite failure (install, load, corrupt index) falls back to grep with a warning, never an error. | [05-cli-search.md](05-cli-search.md) |
| D7 | `users/` zone location | **In the brain.** The brain is one entity for everyone; no exclusion switch. | [01-brain-repo.md](01-brain-repo.md) |
| D8 | Store commit messages as thoughts | **Opt-in per user**, set in that user's global config. Enabling prints a warning that it will grow the brain substantially. | [07-templates.md](07-templates.md) |
| D9 | Distribution | **GitHub only in v1**: GitHub Releases with a tarball and an install script, plus `npm install` from the repo. npm registry publish comes later. | CLAUDE.md |
| D10 | Name | **Keep `thoughts`.** Revisit before a public release. | — |
| D11 | SQLite binding | **`node:sqlite`** when the running Node has it, else **`better-sqlite3`** as an *optional* dependency. Both behind the one search interface; failure of either falls to grep (D6). | [05-cli-search.md](05-cli-search.md) |
| D12 | CLI framework | **commander.** Criterion was "fastest and most reliable to start with"; commander is the smallest, most widely used option with no framework lock-in, so swapping later is cheap if ever needed. | CLAUDE.md |
| D13 | Handlebars helpers | **`date`, `slug`, `upper`, `lower`, `join`.** Add one only when a template needs it. | [07-templates.md](07-templates.md) |
| D15 | Init wizard shape | **Per-tool sub-guides** after a short common section. Each sub-guide is independently re-runnable. | [02-cli-init.md](02-cli-init.md) |
| D16 | Attaching all repos | **Separate `thoughts attach-all` command.** `init` attaches one repo only. | [13-cli-attach-all.md](13-cli-attach-all.md) |
| D17 | `sync` reading code-repo git state | **No.** `status` reads it live. | [03-cli-sync.md](03-cli-sync.md) |
| D18 | Generated-file commits | **Fold into the content commit.** | [03-cli-sync.md](03-cli-sync.md) |
| D19 | Per-repo template overrides | **Not allowed.** Templates change at brain level only so all repos stay in sync. `lint` flags `repos/<id>/templates/`. | [07-templates.md](07-templates.md) |
| D14 | Repo has `.thoughts.yml` but this user never ran `init` | **Hard.** Every command except `init`/`doctor`/`help`/`version` exits 5 and names `thoughts init`. `init` then skips brain/repo-id prompts and runs the tool and integration sub-guides so each user picks their own. Commands inside a brain clone need no symlink, so CI runs there and needs no escape hatch. Kit drift only warns; `thoughts kit update` fixes it. Multiple clones share one `repo_id` from the remote. Git hooks are opt-in. | [02-cli-init.md](02-cli-init.md#attached-not-initialised), [08](08-standard-kit.md) |
| D21 | Secrets in the brain | **Built-in scanner, no bypass.** Filename blocklist + known-format patterns + generic assignment pattern; entropy opt-in. Runs on `sync`, a pre-commit hook in the CLI-owned brain clone, `new --set`, `init` config, and `thoughts scan`. False positives allow-listed by fingerprint with a reason. The CLI never rewrites history. (decided 2026-09-09) | [15-secret-scanning.md](15-secret-scanning.md) |
| D20 | Multiple features on one repo at once | **`thoughts worktree` command** wrapping `git worktree` and creating the brain symlink per worktree. One brain clone per machine. | [14-cli-worktree.md](14-cli-worktree.md) |

## Open

| # | Question | Recommendation (work proceeds under this) |
|---|----------|-------------------------------------------|
| O1 | How does non-interactive `init --yes` create a **new** brain when there is no `.thoughts.yml` and no existing remote? The interactive guide offers "create a new brain"; the flag form in [02](02-cli-init.md) only takes `--brain <url|id>`. | Accept a local filesystem path as the `--brain` value. If it does not exist, or exists as an empty directory, `init` creates the brain there (`git init`, scaffold `brain.yml`/`index.md`/zones, initial commit) and then clones it to `~/.thoughts/brains/<id>` like any other remote. A path is a valid git remote, so no new flag is needed. Proposed 2026-09-09 during milestone 1. |
| O2 | With `--yes` and no `--tools`, which tools are set up? | `--tools` flag → `.thoughts.yml` `tools` → adapters whose `detect()` is true → default `[claude-code]`. Proposed 2026-09-09. |
| O3 | May `init` turn a git repository that is **not** a brain into one? O1 creates a brain only at a missing or empty path, but hosts (Azure DevOps, GitHub) create a remote with a README, so the first brain cannot be created where the team already made the repo: the user has to scaffold at a fresh path and force-push over the placeholder commit. | Keep refusing for now — scaffolding into a directory the user did not expect us to write to is the riskier default, and the workaround is one documented `--force` push. If this keeps biting, the narrow version is to allow it when the repo's work tree holds nothing but a README and the user passes `--force`. Proposed 2026-09-11 after a user hit it on Azure DevOps. |

## Deferred (not blocking)

- **Next version:** `status` showing code branches that reference a thought (needs a branch-naming convention first).
- Org-level brains (design hook exists, see 01), Windows, GitLab/Linear integrations, YAML-defined adapters, semantic search, OKF Attested Computation.
