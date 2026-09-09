# 05 — `thoughts search`

Status: Draft

## Purpose

Find thoughts across every repo in the brain by text, frontmatter, or link. The AI assistant is the primary caller (via the standard kit commands), the human is the secondary one.

## Synopsis

```
thoughts search <query> [--kind <k>] [--repo <id>|--shared|--users] [--type <okf-type>]
                [--tag <t>] [--status draft|stable|deprecated] [--since <duration>]
                [--links-to <path>] [--json] [--limit <n>] [--context <lines>]
```

`<query>` is free text. Empty query with filters is allowed (list mode).

## Backends

Two backends ship in v1 behind one interface (D6). The user picks; the default picks for them.

| Backend | How | When |
|---------|-----|------|
| `grep` | Walk the brain, parse frontmatter, regex over title/description/tags/body. No index, no dependencies. | Always available. The fallback. |
| `sqlite` | SQLite FTS5 index at `~/.thoughts/index/<brain-id>.sqlite`, rebuilt incrementally by `sync` and on demand by `thoughts search --reindex`. | When it loads. Faster on large brains, supports ranking and phrase queries. |

Selection, in order: `--backend grep|sqlite` flag → `search.backend` in global config → `search.backend` in `brain.yml` → `auto`.

`auto` means: try SQLite; if the binding fails to load, the index is missing and cannot be built, or any query throws, **fall back to grep for that call** and print one warning (once per process) naming the cause. Search MUST never fail because of SQLite. `thoughts doctor` reports which backend is active and why.

Binding is `node:sqlite` when the running Node provides it, else `better-sqlite3` (D11). Either way the native piece MUST be an optional dependency: a failed native build during install is not an install failure.

## Matching

Both backends MUST return the same result set for the same query; only ranking quality and speed may differ. Acceptance tests run every search fixture against both.

- Text query: case-insensitive substring / regex (grep) or FTS5 match (sqlite) over title, description, tags, and body. Ranked by: title match > description match > tag match > body match, then recency.
- Frontmatter filters are exact matches applied before text search.
- `--links-to <path>` returns thoughts whose body or `sources[]` link to the given bundle-relative path. This is how an assistant finds "everything that depends on this spec".
- Results MUST include: bundle-relative path, kind, repo/zone, title, `status`, trust tier, last modified, and a snippet with `--context` lines.

## Output

Human:

```
repos/orders-service/decisions/2026-08-20-outbox-pattern.md   decision · stable · human-reviewed · 19d
  Outbox pattern for order events
  …chosen over dual-write because payments-api needs exactly-once delivery…

shared/specs/2026-07-02-event-envelope.md                    spec · stable · machine-confirmed · 68d
  Standard event envelope
```

`--json` emits an array of result objects.

## Acceptance criteria

- `thoughts search idempotency --kind decisions` finds the shared decision from any attached repo, with both backends.
- `thoughts search --links-to shared/specs/2026-07-02-event-envelope.md` lists every thought referencing it.
- Result JSON is stable across runs given no brain changes, and the set of paths is identical across backends.
- With the SQLite binding removed from `node_modules`, `thoughts search x` succeeds via grep and prints exactly one warning.
- With a corrupted index file, same outcome, and `--reindex` repairs it.

## Open questions

- Semantic / embedding search: out of scope. It would require a model, and the CLI never calls one (D5). A purely local embedding index is the only conceivable route and is not planned.
- Should search also cover the code repos' `README`s? No — see non-goals.
