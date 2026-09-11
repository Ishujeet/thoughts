# 07 — Templates

Status: Draft

## Purpose

Templates define the shape of each kind of thought. They are markdown files with frontmatter placeholders and body sections. The built-in set ships with the CLI; an org can override any or all of them.

## Resolution order

For a kind `k` with template name `t`:

1. `--template <path>` given on the command line,
2. `brain.yml` `templates.source`:
   - `builtin` → CLI's embedded templates,
   - `brain` → `<brain>/templates/<t>.md`,
   - `path:<dir>` → `<dir>/<t>.md`,
   - `git:<url>` → cloned to `~/.thoughts/templates/<hash>/` and refreshed on `sync`,
3. fall back to builtin if the chosen source lacks `<t>.md` (warn once).

There is **no per-repo override**. `repos/<id>/templates/` is not a recognised path and `lint` flags it if it exists. Templates change at the brain level only, so every repo in the project produces the same shape of document.

## Built-in templates

All built-ins share this frontmatter skeleton (fields per [09-index-metadata-okf.md](09-index-metadata-okf.md)):

```yaml
---
type: {{type}}
title: {{title}}
description: 
status: draft
tags: []
repo: {{repo_id}}
generated:
  by: {{author}}
  at: {{now}}
sources: []
links:
  ticket: {{ticket}}
  pr: {{pr}}
  branch: {{branch}}
---
```

### `plan` (type: `Plan`)

Sections: **Goal** · **Context** (links to specs/decisions/research, other repos affected) · **Approach** · **Steps** (checklist, each with owning repo) · **Risks & dependencies** · **Done when** · **Out of scope**.

### `spec` (type: `Spec`)

Sections: **Summary** · **Motivation** · **Interface** (API / events / schema, with versioning) · **Behaviour** · **Cross-repo impact** (table: repo → change required) · **Migration / rollout** · **Acceptance criteria** · **Open questions**.

### `research` (type: `Research`)

Sections: **Question** · **What I looked at** (with `sources[]` filled) · **Findings** · **Recommendation** · **Confidence** · **Follow-ups**.

### `decision` (type: `Decision`)

An ADR. Sections: **Status** (proposed/accepted/superseded, mirrored to frontmatter `status`) · **Context** · **Decision** · **Consequences** · **Affected repos** · **Alternatives considered**.

### `pr` (type: `Pull Request`)

Sections: **Summary** · **Why** (links to plan/spec) · **What changed** · **Cross-repo notes** (does another service need to deploy first?) · **Testing** · **Checklist**. This is also the text pasted into the PR body by `/thoughts-pr`.

### `commit` (type: `Commit`)

Not a stored thought by default. It is a **message template** used by `/thoughts-commit`:

```
<scope>: <imperative summary, ≤72 chars>

<why, 1–3 lines>

Refs: <ticket> · Plan: <bundle-relative path> · Spec: <path>
```

**Storing commits as thoughts is opt-in per user** (D8), not per brain. A user enables it in their global config:

```yaml
# ~/.config/thoughts/config.yml
brains:
  acme-checkout:
    store_commits: true
```

`thoughts config set store_commits true` is the supported way to flip it, and it MUST print this warning and require confirmation:

> Storing every commit message as a thought will grow the brain quickly (one file per commit, forever, for everyone who syncs). Most teams only need plans, specs, and decisions. Continue? [y/N]

When enabled, `/thoughts-commit` also writes the message to `repos/<repo-id>/commits/<date>-<short-sha>.md` with `type: Commit`. Other users' commits are not stored unless they opt in themselves.

## Template syntax

Templates are **Handlebars** (D2), deliberately restricted so they stay readable as plain markdown by someone who has never seen the CLI:

- `{{var}}` and `{{object.field}}` substitution.
- `{{#if var}} … {{else}} … {{/if}}` and `{{#each list}} … {{/each}}`.
- A small allow-listed helper set (D13; initially `date`, `slug`, `upper`, `lower`, `join`).
- Nothing else: no partials, no custom helpers from the brain, no inline JavaScript. `thoughts templates lint` rejects anything outside this subset.

Unknown variables render empty and produce a warning (Handlebars `strict` mode is off; we surface missing variables ourselves). HTML escaping is disabled: templates produce markdown, and `{{title}}` must not turn `&` into `&amp;`.

## Validation

`thoughts templates lint` (sub-command of a `templates` group) checks every template in the active source: frontmatter parses after substitution with dummy values, `type` present, no unknown `{{vars}}`.

## Open questions

- Should `spec` and `plan` be one kind with a `phase` field? Kept separate: they have different audiences and lifetimes.
