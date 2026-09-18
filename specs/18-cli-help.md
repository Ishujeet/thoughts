# 18 — `thoughts help`

Status: Draft

## Purpose

Make the CLI discoverable from the terminal alone: what commands exist, which are real versus planned, and where to look next. Help is the only command a user runs before `init`, so it must work with no brain, no config, and no network.

## Synopsis

```
thoughts help [<command>|<topic>]
thoughts <command> --help
```

Built on commander's built-ins ([12-open-decisions.md](12-open-decisions.md) D12, D24). No new dependency.

## Grouped command list

`thoughts help` (bare) prints commands in four fixed groups via `cmd.group()` and a `formatHelp` override:

```
Usage: thoughts [options] [command]

Getting started
  init          Attach a repo to a brain and install the standard kit

Daily
  new           Create a thought from a template
  status        What is in flight across the project

Maintenance
  sync          Pull/push brain content, regenerate indexes
  scan          Run the secret scanner over the brain

Planned (not in this version)
  search        Search thoughts across all repos
  attach-all    Clone and register every repo in a brain at once
  worktree      Git worktrees with the brain symlink in place
  doctor        Diagnose brain, symlink, kit, and config problems
  kit           Inspect and update the standard kit
```

The example shows this version's release scope: `init`, `new`, `status`, `sync`, `scan`, and `help` are shipped; everything else a spec describes is listed under **Planned**. When a planned command ships, its row moves to its real group in the same change that implements it.

- Unimplemented commands appear under **Planned** with the literal marker `not in this version`. A planned command MUST NOT be invokable; if typed, it errors with the same marker.
- Group order is fixed: getting started, daily, maintenance, planned.
- A **global options block** (`--brain <id>`, `--json`, `--quiet`, `--version`, and friends) prints after the groups, before the per-command list.

## Per-command examples

Every command's help ends with an **Examples** section, added via `addHelpText('after')`, showing the two or three invocations a Dev actually types:

```
$ thoughts sync --help
...
Examples:
  thoughts sync                 # pull, regenerate indexes, commit, push
  thoughts sync --pull-only     # just see what came in from other repos
  thoughts sync --watch 30s     # keep a terminal tab syncing
```

Examples use the binary name `thoughts` and the same placeholder conventions as the specs ([specs/README.md](README.md#conventions-used-in-these-specs)).

## Typical session

`thoughts help` (and the root command with no arguments) prints a short typical-session example after the command list:

```
Typical session:
  thoughts init                    # once per repo
  # ... work, plan, spec with your assistant ...
  thoughts sync                    # share and receive brain changes
  thoughts status                  # what is in flight project-wide
```

## `thoughts help <topic>`

A `help` subcommand dispatches on topic before command. Topics are fixed prose, held in `src/help-topics.ts`:

| Topic | Covers |
|-------|--------|
| `brain` | What a brain is, layout, zones, the symlink ([01-brain-repo.md](01-brain-repo.md)) |
| `backends` | git / psql / nebula, the cred-ref rule, immutability ([16-brain-backends.md](16-brain-backends.md)) |
| `secrets` | What the scanner blocks, allow-listing, no bypass flag ([15-secret-scanning.md](15-secret-scanning.md)) |
| `okf` | Frontmatter fields, trust tiers, generated indexes ([09-index-metadata-okf.md](09-index-metadata-okf.md)) |

Rules:

- Topic names are lowercase, singular where natural, and matched exactly (no prefixes, no fuzzy match).
- An unknown topic exits **1** and lists the valid topics.
- Topic content is the CLI's own condensed wording — it must not require reading the specs, but it names the spec file so deeper detail is findable.
- `thoughts help <command>` and `thoughts <command> --help` are equivalent; both exit 0.

## Error-path help

`program.showSuggestionOnError()` is enabled: a mistyped command or flag prints commander's "did you mean" suggestion. Every usage error exits 1 and names the nearest valid alternative rather than dumping full help.

## Acceptance criteria

- `thoughts help`, `thoughts --help`, and `thoughts` with no arguments all exit 0 and print the grouped list with global options.
- Help works on a machine with no brain, no `~/.config/thoughts/`, and no network — it never reads config or the store ([16-brain-backends.md](16-brain-backends.md)).
- Every shipped command's `--help` ends with an Examples block; a test asserts no command ships without one.
- `thoughts help backends` prints the backend topic and exits 0; `thoughts help backendsx` exits 1 listing `brain, backends, secrets, okf`.
- `thoughts statu` prints `did you mean status?` and exits 1.
- Adding the help system introduces no new `dependencies` or `optionalDependencies`.
- Planned commands are listed but exit 1 when invoked.

## Open questions

- Should `thoughts help <topic>` render its content through the template system ([07-templates.md](07-templates.md)) so orgs can extend topics? Leaning no for v1 — help is CLI-owned text, and brain-level template overrides would make help differ per machine.
- Should topic text live in the brain as `shared/` thoughts the CLI can read, so a team can document its own conventions under `thoughts help`? Attractive, but it couples help to a materialised workspace; revisit after the first org-brain user asks for it.
- Do the grouped lists need a `--json` form for tooling? Only if an adapter asks.
