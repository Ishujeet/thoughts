# thoughts

A CLI that attaches a shared, git-backed "brain" to every repo in a multi-repo project so AI coding assistants plan, spec, research, and commit with whole-project context. Full description: [Project.md](Project.md).

## Where things are

- `specs/` — the source of truth for behaviour. Start at `specs/README.md`. Code follows specs; if they disagree, fix one in the same change.
- `specs/12-open-decisions.md` — the decision log plus what is still open. Check it before assuming anything not written in a spec.
- No implementation exists yet. Stack is decided; see below.

## Stack (decided 2026-09-08)

- **TypeScript on Node.js**, ESM, strict mode. Pin the minimum Node LTS in `package.json` `engines`.
- **Handlebars** for templates, restricted to the subset in `specs/07-templates.md`. Templates must stay readable by non-developers.
- **Search**: grep-class and SQLite FTS5 behind one interface. SQLite binding is an optional dependency; any SQLite failure falls back to grep with a warning, never an error.
- **Platforms**: macOS and Linux only. No Windows work in v1.
- **The CLI never calls an LLM.** Not a limitation, a rule.
- **Distribution**: GitHub Releases + install script in v1; npm registry later.
- **CLI framework**: commander. **SQLite binding**: `node:sqlite` when present, else `better-sqlite3` as an optional dependency.
- **Templates are brain-level only.** No per-repo overrides, by decision.
- Anything else not written in a spec: propose it in `specs/12-open-decisions.md` before building on it.

## How to work in this repo

- **Spec first.** New behaviour gets a spec (or a spec change) before code. Each command has its own spec file; cross-cutting concerns (brain layout, OKF metadata, templates, kit, adapters, integrations) have theirs.
- **Keep the spec conventions.** RFC 2119 keywords, `<brain>` / `<repo>` placeholders, a status line at the top, an **Open questions** section at the bottom. Promote a question to `12-open-decisions.md` when it needs a human decision.
- **Vocabulary is fixed in `specs/00-overview.md` glossary.** Brain, thought, repo, zone, kind, adapter, template, standard kit. Use those words; don't invent synonyms.
- **OKF compliance is a hard requirement** for anything written into a brain. See `specs/09-index-metadata-okf.md` and the upstream spec it links.
- **Don't break the user's repo.** Anything `init` installs must be additive, mergeable (managed block), and gitignored where appropriate. This is goal G2 and non-negotiable.

## Design principles (short form)

1. Brain = intent, repos = code. Links both ways.
2. Write at the moment of thinking; the kit hooks the assistant at plan/spec/research/decide/commit time.
3. Per-repo ownership inside one shared repo: `repos/<id>/` is owned, `shared/` is for cross-repo content.
4. Indexes are generated, never hand-edited.
5. Fail soft: a missing brain degrades with a message, never a crash.
6. No secrets in the brain, ever. Every write path scans; there is no bypass flag, only per-finding allow-listing with a reason. Never print a matched secret unmasked, not even in debug logs or tests.

## When the user asks to…

- **add a command** → new `specs/NN-cli-<name>.md` following the shape of `02`–`06`, add a row to `specs/README.md`.
- **change the brain layout** → edit `specs/01-brain-repo.md` and check `02`, `03`, `09` for knock-on effects.
- **add a tool** → `specs/11-ai-tool-adapters.md` table + adapter section.
- **add an integration** → `specs/10-integrations.md` using the common contract.
- **add a secret detector** → the pattern table in `specs/15-secret-scanning.md`, plus a positive and a placeholder-negative fixture.
- **decide something** → move the row from Open to Decided in `specs/12-open-decisions.md` with the date, then propagate to affected specs in the same change.
- **scaffold the code** → `package.json` with `engines`, `tsconfig` strict + ESM, `src/commands/<name>.ts` one per spec 02–06, `src/brain/` for layout + OKF, `src/adapters/`, `src/integrations/`, `src/search/{grep,sqlite}.ts` behind one interface, `templates/` and `kit/` as embedded assets.
