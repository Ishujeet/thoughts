# 13 — `thoughts attach-all`

Status: Draft

## Purpose

Bootstrap a developer's machine for a whole project: clone every repo listed in the brain's `brain.yml` and run `thoughts init --yes` in each. This is the "new joiner" command. `init` itself only ever attaches the repo you are standing in.

## Synopsis

```
thoughts attach-all --brain <url|id> [--into <dir>] [--only <repo-id,...>] [--skip <repo-id,...>]
                    [--tools claude-code,codex,pi] [--dry-run] [--continue-on-error]
```

## Behaviour

1. Resolve and clone/fetch the brain (same as `init` step 1).
2. Read `brain.yml` `repos[]`. Apply `--only` / `--skip`.
3. For each repo, in listed order:
   - Target dir is `<--into>/<repo-id>` (default: current directory). If it exists and is a git work tree with a matching remote, fetch instead of clone. If it exists and does not match, skip with a warning.
   - Clone via the `remote` in `brain.yml`.
   - Run `init --yes --brain <id> --repo-id <id> --tools <tools>` in it. Because the repo carries `.thoughts.yml`, this is the no-prompt path.
4. Print a table: repo, action (cloned / fetched / skipped), init result, path.

Stops on the first failure unless `--continue-on-error`. `--dry-run` prints the table with actions and touches nothing.

## Rules

- MUST NOT modify any repo it did not clone or fetch cleanly.
- MUST NOT run the interactive guide. If a repo lacks `.thoughts.yml` (listed in the brain but never attached by its own team), `attach-all` skips it and says so; someone must run `init` in that repo first.
- Tool selection defaults to the union of `tools` across the repos' `.thoughts.yml`, so a fresh machine ends up matching the team's setup.

## Exit codes

Same table as `init`, plus `6`: one or more repos failed (with `--continue-on-error`).

## Acceptance criteria

- Empty directory + brain with three repos → three clones, three symlinks, three kits, one summary table.
- Re-run in the same directory → three fetches, zero prompts, `up-to-date` kit status everywhere.
- One repo remote unreachable → exit 2 without `--continue-on-error`; the other two complete with it.

## Open questions

- Should `attach-all` also offer to clone repos that are in the brain's GitHub org but not yet in `brain.yml`? No: `brain.yml` is the roster; discovery is a different feature.
