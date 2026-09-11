# 08 — Standard kit

Status: Draft

## Purpose

The files `init` installs into a code repo so that an AI assistant uses the brain automatically. Four parts: **instructions**, **commands**, **skills**, **agents**. The kit is tool-agnostic in content; adapters ([11-ai-tool-adapters.md](11-ai-tool-adapters.md)) decide file paths and formats.

## Source of the kit

1. `<brain>/standard/` if present (org override),
2. else the CLI's embedded kit.

Each kit file carries a version comment so `init` can detect outdated copies.

## 1. Instructions block

Inserted into the tool's instruction file (`CLAUDE.md`, `AGENTS.md`, …) between `thoughts:begin/end` markers. Canonical content:

```markdown
## Project brain (thoughts)

This repo is part of the **{{brain_name}}** project. Cross-repo context lives in `thoughts/` (a symlink to the shared brain). Read it; write to it.

- If `thoughts/` is missing, not a symlink, or empty, **stop and tell the user to run `thoughts init`**. Do not create the directory, do not work around it, do not continue the task without it.
- Before planning, designing, or answering "how does X work across services": run `thoughts search <topic>` and read `thoughts/shared/decisions/` and `thoughts/repos/*/specs/` that match.
- This repo owns `thoughts/repos/{{repo_id}}/`. Write there. Cross-repo decisions go to `thoughts/shared/decisions/`. Never edit another repo's directory.
- Create documents with `thoughts new <kind> "<title>"`, never by hand, so frontmatter is right.
- Use the commands: `/thoughts-plan`, `/thoughts-spec`, `/thoughts-research`, `/thoughts-decide`, `/thoughts-commit`, `/thoughts-pr`, `/thoughts-status`.
- After writing to `thoughts/`, run `thoughts sync`.
- Frontmatter `status: draft` means in progress. Set `stable` only when the human confirms.
- **Never write secrets into `thoughts/`.** No API keys, tokens, passwords, private keys, connection strings with passwords, or `.env` contents, even as examples. Refer to a secret by its env var or vault path name only. If you must show a shape, write `<redacted:kind>`. `thoughts sync` refuses to commit if it finds one.
- Content under `thoughts/users/` is personal scratch. Read it for context, but prefer `repos/` and `shared/` when they disagree, and never cite a `users/` note as a project decision.
```

## 2. Commands

Each command is a prompt file the tool exposes as a slash command. Behaviour contract:

| Command | Does |
|---------|------|
| `/thoughts-plan <goal>` | `search` for related thoughts → summarise cross-repo impact → `new plan` → fill sections → list which other repos must be told. |
| `/thoughts-spec <feature>` | As above with the `spec` template; MUST fill the **Cross-repo impact** table, even if "none". |
| `/thoughts-research <question>` | Investigate code + brain → `new research` → fill with `sources[]` pointing at files and thoughts read. |
| `/thoughts-decide <topic>` | Draft an ADR. If more than one repo is affected, use `--shared`. List alternatives. Leave `status: draft` for human acceptance. |
| `/thoughts-commit` | Stage review → generate message from the `commit` template, linking the active plan/spec/ticket → commit. |
| `/thoughts-pr` | `new pr --from <active plan or spec>` → fill → output body for the PR (and create it via integration if configured). |
| `/thoughts-status` | Run `thoughts status --json`, present it, and highlight items affecting this repo. |
| `/thoughts-sync` | Run `thoughts sync` and summarise what arrived from other repos. If it exits 7 (secret found), show the masked findings and ask the user how to fix; never allow-list on the user's behalf. |

Commands MUST degrade if the brain is missing: say so and continue without it.

## 3. Skills (optional)

Installed on request during `init` (`--skills`). Each is a directory with a `SKILL.md` and supporting files, in the format each adapter expects.

| Skill | Purpose |
|-------|---------|
| `cross-repo-impact` | Method for finding which services a change touches: read specs' interface sections, grep event names, list consumers. |
| `adr-writing` | How to write a good decision record; when to supersede vs. amend. |
| `spec-review` | Checklist for reviewing a spec for cross-repo gaps before marking `stable`. |
| `brain-hygiene` | Periodic clean-up: find stale thoughts, missing links, drafts older than N days. |

Skills are the extension point for orgs: `<brain>/standard/skills/` is copied verbatim.

## 4. Agents

- `agents.md` (generic) — describes roles an assistant can adopt: **Planner**, **Spec author**, **Researcher**, **Reviewer**. Installed to the repo root only if absent.
- Tool-specific agent definitions (e.g. claude-code sub-agents) that wrap those roles with the right tool permissions: a `thoughts-researcher` agent is read-only over code and brain; a `thoughts-writer` agent may write under `thoughts/repos/<id>/` and `thoughts/shared/`, and MUST run `thoughts scan --staged` before handing back.

## Versioning

Kit version = CLI version. `init` records `kit_version` in `.thoughts.yml`.

- `thoughts kit status` — table of every kit file: `up-to-date`, `modified locally`, `outdated`, `missing`.
- `thoughts kit update [--all | <file>...]` — applies updates with the same merge rules as `init`: managed blocks are replaced, locally modified files are skipped unless `--force`, user content outside managed blocks is never touched.
- Re-running `thoughts init` offers the same update per file inside the guide.
- Every command warns once per run when the kit is outdated; nothing refuses because of it.

## Open questions

- Should commands call the CLI directly, or should the CLI expose a machine-readable `--json` for everything and commands parse that? Both: commands use `--json` where they need structure.
- Single instruction block vs. one per tool with tool-specific wording? Single block; adapters may add a short tool-specific suffix.
