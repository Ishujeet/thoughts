# 11 — AI tool adapters

Status: Draft

## Purpose

An adapter knows where a given AI coding tool reads instructions, commands, skills, and agents, and in what format. `init` drives adapters; the kit content ([08-standard-kit.md](08-standard-kit.md)) is shared.

## Adapter contract

```
name()                          # "claude-code"
detect(repo) -> bool            # tool already configured here?
instruction_file(repo) -> path  # where to insert the managed block
install_commands(repo, kit)
install_skills(repo, kit, selected)
install_agents(repo, kit)
verify(repo) -> [Issue]         # for `thoughts kit status`
```

Each adapter MUST only create files under paths the tool documents, MUST NOT overwrite user files (merge or skip with a message), and MUST be re-runnable.

## claude-code

| Component | Path |
|-----------|------|
| Instructions | `CLAUDE.md` (managed block) |
| Commands | `.claude/commands/thoughts-*.md` |
| Skills | `.claude/skills/<name>/SKILL.md` |
| Agents | `.claude/agents/thoughts-researcher.md`, `.claude/agents/thoughts-writer.md` |
| Optional | `.claude/settings.json` permission allowlist for `thoughts *` commands (offered, not forced) |

## codex

| Component | Path |
|-----------|------|
| Instructions | `AGENTS.md` (managed block) |
| Commands | Codex has no slash-command directory in the same sense; commands are rendered as a **"Workflows"** section inside the managed block, each with the exact steps and CLI calls. |
| Skills | `.codex/skills/<name>/SKILL.md` if the installed codex version supports it; otherwise folded into `AGENTS.md`. |
| Agents | Roles described in `AGENTS.md`; no separate agent files. |

## pi

| Component | Path |
|-----------|------|
| Instructions | `AGENTS.md` (managed block), shared with codex if both selected — one block, one file |
| Commands | `.pi/prompts/thoughts-*.md` |
| Skills | `.pi/skills/<name>/SKILL.md` |
| Agents | `.pi/agents/` if supported; else roles in `AGENTS.md` |

> Exact pi paths must be confirmed against the current pi release before implementation. Treat this table as the intended shape.

## Shared `AGENTS.md`

When two adapters both target `AGENTS.md`, `init` writes a single managed block. Tool-specific notes go in a short sub-section per tool inside the block.

## Detection & guidance

`init` runs `detect()` for every adapter and pre-selects the ones found. For tools not detected it prints a one-paragraph setup guide (install link, how to enable commands/skills) before installing anything, so a user new to the tool isn't left with files they don't know how to use.

## Adding an adapter

1. Implement the contract.
2. Add a row to the tables above and a section to `docs/`.
3. Add an integration test that runs `init --tools <new>` on a fixture repo and snapshots the resulting tree.

## Open questions

- Should adapters be user-extensible (a YAML describing paths) rather than code? Attractive for long-tail tools; do after the first three prove the contract.
