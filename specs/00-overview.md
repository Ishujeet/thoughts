# 00 — Overview

Status: Draft

## One-line description

`thoughts` is a CLI that attaches a shared, git-backed "brain" to every repository in a multi-repo project so that AI coding assistants (and humans) plan, spec, research, and commit with the context of the **whole** project instead of one repo.

## The problem

AI coding tools are excellent inside a single repo: they read the code, understand the request, and write good code. Real projects are not single repos. They are split into services, each with one or more repositories. When a developer (or their AI assistant) works in `payments-api`, they have no reliable view of:

- what `orders-service` is changing this week,
- the decision made last month about idempotency keys,
- the spec that `notifications` is implementing against `payments-api`'s new endpoint,
- which tickets are in flight and which repos they touch.

Context lives in people's heads, in chat, or in a wiki nobody updates. The result is drift: services move out of alignment, work gets duplicated or contradicted, and integration surprises land late.

## The idea

Give the project one **brain**: a plain git repository holding plans, specs, research, decisions, and an index of all of it. Every code repo in the project gets:

1. a symlink (`<repo>/thoughts`) to a local clone of the brain,
2. a small standard kit (commands, skills, agents, `CLAUDE.md`-style instructions) that tells the AI assistant to read and write the brain at the right moments,
3. a CLI to keep it all in sync, searchable, and observable.

Nothing in the brain is proprietary to any one AI tool. It is markdown with YAML frontmatter, organised per the Open Knowledge Format (OKF), so any tool, script, or human can consume it.

## Goals

- **G1. Whole-project context, everywhere.** From any repo, an assistant can find what other repos are planning, building, or have decided.
- **G2. Zero disruption.** Attaching a brain never changes how a repo builds, tests, or ships. All additions are opt-in files and a gitignored symlink.
- **G3. Tool-agnostic.** First-class support for claude-code, codex, and pi. Adding a fourth tool means writing an adapter, not redesigning the brain.
- **G4. Plain files, plain git.** No server, no database, no lock-in. The brain is readable with `cat` and diffable with `git`.
- **G5. Convention with escape hatches.** Sensible default templates and layout, but an org can bring its own templates and layout.
- **G6. Observable.** `thoughts status` answers "what is in flight across the project?" in one command.

## Non-goals (for now)

- Not a wiki, ticketing system, or chat replacement. Integrations link to those; the brain does not replace them.
- Not a code search tool. `thoughts search` searches the brain, not source code.
- Not a hosted service. No accounts, no SaaS backend.
- Not real-time collaboration. Sync is git-based and explicit (or on a timer); conflicts are resolved with git.
- Not an AI agent itself. The CLI **never** calls an LLM. It arranges files so that other tools' agents work better. This is a design constraint, not a v1 limitation (decision D5). A CLI that needed a model would defeat its purpose: the assistants already have one.
- Not a Windows tool in v1. macOS and Linux only (D4).

## Personas

- **Developer (Dev)** — works in one or two repos daily, uses an AI assistant, wants it to "just know" about the rest of the project.
- **Tech lead (Lead)** — owns the project across repos, wants to see what's in flight, enforce templates, and make decisions discoverable.
- **Platform / DevEx engineer (Platform)** — sets up the brain for an org, supplies custom templates, wires integrations.

## Principles

1. **Brain is the source of truth for intent; repos are the source of truth for code.** Plans and specs live in the brain. Code lives in repos. Links go both ways.
2. **Write at the moment of thinking.** The standard kit hooks the assistant at plan / spec / research / decide / commit time, so the brain gets written as a side effect of normal work.
3. **Per-repo ownership inside a shared repo.** Each code repo owns a directory in the brain. Shared/project-level content is explicitly separate. This keeps blame, review, and conflicts tractable.
4. **Index everything, generate nothing by hand.** `index.md` and `log.md` are produced by the CLI from frontmatter. Humans edit concepts, not indexes.
5. **Fail soft.** A missing brain, a broken symlink, or an unknown frontmatter field degrades gracefully with a clear message. The assistant must still be able to work.
6. **No secrets, ever.** The brain is cloned everywhere and fed to assistants. Keys, tokens, and passwords are refused at every write path and cannot be waved through with a flag. See [15-secret-scanning.md](15-secret-scanning.md).

## Glossary

| Term | Meaning |
|------|---------|
| **Brain** | The shared git repository holding all thoughts for a project. One brain per project (or per org, containing several projects). |
| **Thought** | Any document in the brain: plan, spec, research note, decision record, PR description, etc. Each thought is an OKF concept (a markdown file with frontmatter). |
| **Repo** | A code repository attached to a brain. |
| **Attach** | The act of linking a repo to a brain via `thoughts init`. |
| **Standard kit** | The bundle of skills, agents, commands, and instruction files installed into a repo by `init`. |
| **Adapter** | Tool-specific logic that knows where claude-code / codex / pi expect instructions, commands, and skills. |
| **Template** | A file under `<brain>/templates/` (or the built-in default set) used by `thoughts new` and by the standard kit's commands. |
| **In flight** | A thought with `status: draft` or an integration item (PR, ticket) that is open and linked from a thought. |

## Open questions

- None at this level. Brain scope is decided (D3: one brain per project, org level reserved for later); see [01-brain-repo.md](01-brain-repo.md#future-org-level-brains).
