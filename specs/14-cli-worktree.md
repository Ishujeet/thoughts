# 14 — `thoughts worktree`

Status: Draft

## Purpose

Work on several features of the same repo at once using git worktrees, with the brain available in each one. A plain `git worktree add` leaves you without `thoughts/`, because the symlink is gitignored and worktrees start from the committed tree only.

## Synopsis

```
thoughts worktree add <branch> [--path <dir>] [--from <base-branch>] [--plan <thought-path>]
thoughts worktree list
thoughts worktree remove <branch|path> [--force]
```

## `add`

1. Preflight: current repo must be initialised (see [02-cli-init.md](02-cli-init.md#attached-not-initialised)).
2. Run `git worktree add <path> <branch>` (creating the branch from `--from`, default the repo's default branch, if it does not exist). Default `--path` is `../<repo-id>--<branch-slug>`, a sibling of the main clone.
3. Create `<path>/thoughts` → the same brain clone the main clone uses. One brain clone per machine; worktrees never get their own.
4. Register the path in global config `attached[]` with the same `repo_id`.
5. If `--plan` is given, write `links.branch: <branch>` into that thought's frontmatter so `status` can tie the worktree to the plan (this is the convention the next-version branch display in [04-cli-status.md](04-cli-status.md) will use).
6. Print the path and a one-line `cd` hint.

Kit files (`CLAUDE.md`, `.claude/commands/`, …) are committed, so they are already present in the worktree. Nothing else is copied.

## `list`

Wraps `git worktree list` and adds columns: symlink OK / missing, linked thought (from `links.branch`), unsynced brain edits made from that path.

## `remove`

Runs `git worktree remove` and drops the path from global config. Refuses if the worktree has uncommitted code changes unless `--force`. Brain edits are not affected: they live in the brain clone, not the worktree.

## Rules

- MUST NOT create a second brain clone. All worktrees of all repos on a machine share `~/.thoughts/brains/<brain-id>/`.
- `thoughts doctor` reports worktrees whose symlink is missing (created by a raw `git worktree add`) and offers to fix them; `thoughts init` inside such a worktree also fixes it.

## Acceptance criteria

- `thoughts worktree add feat/refund-v2` → new sibling dir, branch checked out, `thoughts/` resolves to the brain, `thoughts status` works from inside it.
- Two worktrees edit different thoughts, `sync` from either → both edits in one brain commit, no duplication.
- `git worktree add` by hand, then `thoughts doctor` → reports the missing symlink; `thoughts init` there creates it and nothing else.

## Open questions

- Should `add` also create the plan thought when `--plan` names a path that does not exist yet? Convenient, but `new` already does that. Leaning: no.
