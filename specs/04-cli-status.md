# 04 — `thoughts status`

Status: Draft

## Purpose

Answer "what is in flight across the project?" from any attached repo. Combines brain content (draft thoughts), local git state, and integration state (open PRs, tickets) into one view.

## Synopsis

```
thoughts status [--repo <id>|--all] [--kind plans|specs|...] [--mine]
                [--since <duration>] [--json] [--no-integrations] [--no-graph]
```

Default scope is `--all` (every repo in the brain) with the current repo listed first.

## What counts as "in flight"

A thought is in flight when any of:

- `status: draft` in frontmatter,
- it has an unresolved `stale_after` in the past (shown as **stale**, a separate bucket),
- it links to an integration item (PR / ticket / work item) that the integration reports as open,
- it was modified in the brain within `--since` (default 14d).

Local, uncommitted brain changes are shown in a **local, unsynced** section so the Dev remembers to `sync`.

## Output

Human format (default):

```
acme-checkout · 3 repos · synced 4m ago

payments-api (you)
  spec      Refund endpoint v2                 draft   CHK-142  PR #88 open   2d
  decision  Idempotency key format             stable                         9d
  ⚠ unsynced: research/2026-09-08-stripe-webhooks.md

orders-service
  plan      Split order-events consumer        draft   CHK-150               1d
  research  Outbox pattern evaluation          draft                         5d

shared
  decision  Retry budget per service           draft   ← needs review from payments-api, orders-service
  
stale (2)
  repos/notifications/specs/2025-11-02-sms-provider.md   stale_after 2026-06-01
```

`--json` emits one object per row with all fields, for scripting and for adapters' `/thoughts-status` command.

## Data sources

| Source | Cost | Cached |
|--------|------|--------|
| Brain frontmatter | local file read | no |
| Brain git (last sync time, unsynced files) | local git | no |
| Current repo git (branch, dirty state) | local git | no |
| Integrations (PR/ticket state) | network | yes, 5 min, in `~/.thoughts/cache/` |

The integrations row is unimplemented until [10-integrations.md](10-integrations.md) ships: the `CHK-142` / `PR #88` columns stay empty, `--no-integrations` is accepted, and when integrations are absent one warning says so.

`--no-integrations` skips network entirely and is implied when offline.

## Codegraph

When the brain holds a code graph for the attached repos ([17-codegraph.md](17-codegraph.md)), `status` reports it per repo:

- **Counts** — `files · symbols · edges` extracted from that code repo.
- **Staleness** — `fresh` when the stored graph commit matches the repo's `HEAD`; `stale — n commits ahead` when the repo has moved; `absent` when the repo was never extracted or is not a supported language.
- **Cross-repo deps** — sibling repos whose modules this repo imports (matched at brain level by package name), i.e. which other repos' graphs touch the current repo.

`--no-graph` skips the section entirely. `--json` carries a `graph` array with one object per repo (`files`, `symbols`, `edges`, `staleness`, `codeCommit`). Staleness is computed from git only; a repo whose graph was never built, or whose last extraction failed, shows `absent`. `status` never fails because of the graph.

## Cross-repo warnings

`status` MUST warn when:

- the working tree has edits under another repo's `repos/<id>/` directory,
- a thought's `resource` or `sources[].resource` points to a repo not in `brain.yml`,
- the local brain is more than N commits behind remote (N configurable, default 20).

## Acceptance criteria

- With three attached repos and a mix of draft/stable thoughts, output groups by repo and shows drafts only, plus stale bucket.
- `--json | jq` round-trips every field shown in human output.
- Offline: completes without integrations in under 1s for a brain of 1,000 thoughts.

## Next version

- Show code branches that reference a thought (branch named after a plan/spec slug, or a `Plan:` trailer in commits). Needs a naming convention first; planned for the release after v1.

## Open questions

- None for v1.
