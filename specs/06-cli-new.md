# 06 — `thoughts new`

Status: Draft

## Purpose

Create a new thought from a template, in the right place, with correct frontmatter, and open it (or print its path for an assistant to fill in).

## Synopsis

```
thoughts new <kind> <title> [--shared | --repo <id> | --user]
             [--template <name>] [--set key=value ...]
             [--from <path>]  [--open | --print-path] [--json]
```

Examples:

```
thoughts new spec "Refund endpoint v2"
thoughts new decision "Retry budget per service" --shared
thoughts new research "Stripe webhook ordering" --set ticket=CHK-142
thoughts new pr --from repos/payments-api/plans/2026-09-01-refunds.md
```

## Behaviour

1. Resolve zone: default is the current repo (`repos/<repo-id>/`); `--shared` / `--user` override. Outside a repo, `--repo` or `--shared` is required.
2. Resolve template: `brain.yml` `kinds.<kind>.template`, then `--template`. Template source order is in [07-templates.md](07-templates.md).
3. Compute filename: `<YYYY-MM-DD>-<slug>.md`, slug from title (lowercase, `[a-z0-9-]`, max 60 chars). If the file exists, append `-2`, `-3`, …
4. Render frontmatter and body. Variables available to templates:

   | Variable | Source |
   |----------|--------|
   | `title`, `slug`, `date` | from args |
   | `kind`, `type` | kind name and its OKF `type` |
   | `repo_id`, `brain_name` | config |
   | `author` | `human:<user-id>` from global config |
   | `branch`, `commit` | current code repo git state, if inside one |
   | `ticket`, `pr`, any `--set` key | user supplied |
   | `from` | path given by `--from`, plus its parsed frontmatter as `from.*` |

5. Scan every `--set` value and the rendered file for secrets ([15-secret-scanning.md](15-secret-scanning.md)). A finding aborts before anything is written.
6. Write the file, print its bundle-relative path (always, even with `--open`), and `--json` for the structured version.
7. Do NOT sync. The user or assistant edits first; `sync` happens later.

## `--from`

Pre-links the new thought to an existing one: adds it to `sources[]` and, for `pr` and `commit` kinds, pulls the title and summary into the body. This is the intended path for "turn this plan into a PR description".

## Acceptance criteria

- `thoughts new spec "X"` inside `payments-api` creates `repos/payments-api/specs/<date>-x.md` with valid OKF frontmatter and `status: draft`.
- Same title twice → second file has `-2` suffix.
- `--set foo=bar` on a template that doesn't use `foo` is a warning, not an error.
- Template rendering errors name the template file and line.
- `--set token=ghp_…` → refused, no file created, value masked in the message.

## Open questions

- None. Templating engine is decided (D2, Handlebars); see [07-templates.md](07-templates.md#template-syntax).
