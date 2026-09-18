# thoughts — Specifications

This folder is the source of truth for **what** `thoughts` does and **why**. Code follows specs, not the other way round. When behaviour and a spec disagree, fix one of them in the same change.

## Reading order

| # | Spec | Covers | Status |
|---|------|--------|--------|
| 00 | [Overview](00-overview.md) | Problem, goals, non-goals, glossary, principles | Draft |
| 01 | [Brain repository](01-brain-repo.md) | Layout of the shared brain workspace and how repos attach to it | Draft |
| 02 | [`thoughts init`](02-cli-init.md) | Attaching a repo to a brain, installing the standard kit, tool setup | Draft |
| 03 | [`thoughts sync`](03-cli-sync.md) | Pull/push of brain content, conflict handling | Draft |
| 04 | [`thoughts status`](04-cli-status.md) | What is in flight across the project | Draft |
| 05 | [`thoughts search`](05-cli-search.md) | Searching thoughts across all repos | Draft |
| 06 | [`thoughts new`](06-cli-new.md) | Creating documents from templates | Draft |
| 07 | [Templates](07-templates.md) | plan / spec / PR / commit / research / decision templates | Draft |
| 08 | [Standard kit](08-standard-kit.md) | skills/, agents/, commands/, CLAUDE.md (and equivalents) | Draft |
| 09 | [Index & metadata (OKF)](09-index-metadata-okf.md) | Frontmatter, `index.md`, `log.md`, trust tiers | Draft |
| 10 | [Integrations](10-integrations.md) | GitHub, Azure DevOps, Jira | Draft |
| 11 | [AI tool adapters](11-ai-tool-adapters.md) | claude-code, codex, pi | Draft |
| 12 | [Open decisions](12-open-decisions.md) | Decision log and things not yet decided | Living |
| 13 | [`thoughts attach-all`](13-cli-attach-all.md) | Cloning and registering every repo in a brain at once | Draft |
| 14 | [`thoughts worktree`](14-cli-worktree.md) | Git worktrees with the brain symlink in place | Draft |
| 15 | [Secret scanning](15-secret-scanning.md) | Keeping keys, tokens, and passwords out of the brain | Draft |
| 16 | [Brain backends](16-brain-backends.md) | git, PostgreSQL, and NebulaGraph stores behind one brain layout; per-backend sync | Draft |
| 17 | [Codebase graph](17-codegraph.md) | tree-sitter code graph per repo, updated by `sync`, surfaced in `status` | Draft |
| 18 | [`thoughts help`](18-cli-help.md) | Grouped help output and `thoughts help <topic>` | Draft |

## Status legend

- **Draft** — written, not yet reviewed. May change freely.
- **Accepted** — reviewed; changes need a note in the spec's changelog section.
- **Implemented** — code exists and matches the spec.
- **Living** — expected to change continuously.

## Conventions used in these specs

- MUST / SHOULD / MAY follow RFC 2119.
- `<brain>` means the root of the attached brain repo. `<repo>` means the root of the code repo the user is working in.
- Command examples use `thoughts` as the binary name.
- Each spec ends with **Open questions**. Move a question to [12-open-decisions.md](12-open-decisions.md) once it needs a decision from a human.
