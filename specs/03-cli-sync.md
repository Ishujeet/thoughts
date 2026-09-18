# 03 — `thoughts sync`

Status: Draft

## Purpose

Keep the local brain clone aligned with the remote and with the local working tree: pull new thoughts from other repos, regenerate indexes, commit and push local changes.

## Synopsis

```
thoughts sync [--pull-only | --push-only] [--message <msg>] [--no-push]
              [--watch [<interval>]] [--quiet]
```

## Behaviour

0. **Scan for secrets** — every staged or modified file goes through the scanner in [15-secret-scanning.md](15-secret-scanning.md). Any block-severity finding stops `sync` with exit 7 before anything is committed. There is no flag to bypass this; false positives are allow-listed by fingerprint with a reason.
1. **Validate** — every changed or new `.md` under a zone MUST parse as an OKF concept (frontmatter present, `type` set). Invalid files block the commit with a file:line error unless `--allow-invalid`.
2. **Regenerate** — rebuild every `index.md` and append to `log.md` from frontmatter (see [09-index-metadata-okf.md](09-index-metadata-okf.md)). Generated files are deterministic: same inputs → byte-identical output.
3. **Commit** — stage everything under the brain, commit with a message. Default message:
   ```
   thoughts(<repo-id>): <n> added, <m> updated
   
   - added   repos/payments-api/specs/2026-09-08-refund-endpoint.md
   - updated shared/decisions/2026-09-01-idempotency-keys.md
   ```
   Author is the git user of the brain clone. `--message` overrides the first line only. For non-git backends ([16-brain-backends.md](16-brain-backends.md)) there is no git commit: this step writes the workspace and the message becomes the store's history entry for the sync.
4. **Pull** — `git` backend: `git pull --rebase` from the brain remote (unchanged from v1). Non-git backends have no separate pull step; the store is read as part of the sync itself (psql: inside the same transaction; nebula: a read round-trip before the write).
5. **Push** — deliver the commit to the store, per backend:
   - `git`: `git push` unless `--no-push` or no remote.
   - `psql`: the whole sync runs as a single transaction under an advisory lock; a stale `base_rev` in the store aborts it (exit 4, see Conflict handling).
   - `nebula`: statements are applied without transactions; on conflict the store wins (see Conflict handling).
6. **Reindex** — if the SQLite search backend is active, update the FTS index incrementally from the files changed since the last sync. Index failures are logged and ignored; they never fail `sync` (see [05-cli-search.md](05-cli-search.md#backends)).
7. **Codegraph** — if the attached code repo has a code graph ([17-codegraph.md](17-codegraph.md)), re-extract it incrementally against `HEAD` (diff against the stored commit; full rebuild past 500 changed files or when the graph metadata is missing). Any grammar or extraction failure prints exactly one warning and `sync` continues — the graph is never a reason for `sync` to fail.
8. **Report** — print what came in from other repos, grouped by `repos/<id>`, with title and kind. This is the "what's new" feed and is the main reason a Dev runs `sync`.

Order is scan → validate → regenerate → commit → pull → push → reindex → codegraph, so that local work is always committed before a rebase touches the tree.

## Conflict handling

- Rebase conflicts in **concept files** stop `sync` with the standard git conflict markers and a message pointing to the file. The user resolves with git; `thoughts sync` then continues.
- Rebase conflicts in **generated files** (`index.md`, `log.md`) are auto-resolved by taking either side and regenerating. Generated files never require human conflict resolution.
- Generated `log.md` is append-only and date-grouped, so concurrent appends from different repos merge cleanly in most cases.
- `psql`: no rebase. A stale `base_rev` (another repo wrote to the store since this clone last read it) aborts the transaction with exit 4 and names the conflicting thought; the user reconciles in the workspace and re-runs `sync`.
- `nebula`: no transactions. On conflict the **store wins**: the local change is discarded, `sync` prints a warning naming what was lost, and appends a note to `log.md`.

## Watch mode

`--watch [30s]` runs the sync loop on an interval, suppressing "nothing to do" output. Intended for a terminal tab or a background service. It MUST back off on repeated remote failures and MUST NOT retry a conflicted rebase automatically.

## Hooks

`brain.yml` MAY declare `hooks.pre_sync` and `hooks.post_sync` (shell commands run in the brain root). Use case: run a linter, notify a chat channel. Hooks are opt-in and printed before running the first time.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Synced (or nothing to do) |
| 1 | Validation failed |
| 7 | Secret found; nothing committed |
| 4 | Conflict requires manual resolution |
| 2 | Brain store unreachable (local commit still made) |

## Acceptance criteria

- Two clones, each adds a spec to its own repo dir, both sync → both end with both specs and identical `index.md`.
- Both edit the same shared decision → second `sync` exits 4 with the file named; after `git rebase --continue`, `sync` finishes.
- Offline → local commit succeeds, exit 2, next online `sync` pushes it.
- A file containing a live-looking API key → exit 7, brain git status unchanged, key masked in output.

## Decided

- `sync` does not read the code repo's git state. That is `status`'s job, done live.
- Regenerated `index.md` / `log.md` are folded into the content commit. No separate "regenerate indexes" commits.

## Open questions

- None.
