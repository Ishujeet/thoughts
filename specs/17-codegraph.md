# 17 — Codebase graph

Status: Draft

## Purpose

Let repos understand each other's *structure*: what modules exist in `orders-service`, what symbols it exports, and what it imports from `payments-api` — without reading the other repo's code. The graph is generated data derived from each repo's source at known commits, stored in the brain next to the thoughts that talk about that code. It gives assistants the map that text search over markdown cannot: "which thought mentions the thing I am importing?"

## How it is built

Parsing uses **web-tree-sitter** (WASM) so no native build is involved. Grammars and the WASM runtime ship as `optionalDependencies` (`web-tree-sitter`, `tree-sitter-wasms`) per the same rule as the SQLite binding ([05-cli-search.md](05-cli-search.md#backends), D11): a failed install is not an install failure.

Languages in v1: `ts`, `tsx`, `js`, `jsx`, `py`, `go`, `rs`. Files of other extensions are listed as file nodes but contribute no symbol or import edges. Codegen language is reserved for later.

## RepoGraph schema

Per repo, a graph of **nodes** and **edges**:

**Nodes** — `file | symbol | module`, each with a stable hash id (hash of repo id + node kind + canonical path/name, so ids survive regeneration):

| Kind | Identity | Carries |
|------|----------|---------|
| `file` | repo-relative path | content sha, language |
| `symbol` | file path + qualified name | kind (function, class, method, type, const), line range |
| `module` | package / module name from the repo's manifest or directory layout | name, manifest path |

**Edges** — `contains` (file→symbol, module→file), `imports` (file→file or file→module), `calls` (symbol→symbol, intra-file resolution only in v1), `imports_repo` (module→module, cross-repo, see below).

Determinism: node and edge lists MUST be sorted canonically so the same tree at the same commit produces a byte-identical graph. Every node and edge carries `codeCommit` — the commit sha it was extracted from — so staleness is checkable without re-parsing.

## Storage

Stored per repo inside the brain, in whatever shape the backend uses ([16-brain-backends.md](16-brain-backends.md)):

| Backend | Where | Shape |
|---------|-------|-------|
| `git` | `repos/<repo-id>/codegraph/` | `graph.json` (nodes + edges), `meta.yml` (`codeCommit`, generated-at, counts), and a generated human-readable `index.md` |
| `psql` | `codegraph_nodes`, `codegraph_edges`, `codegraph_meta` tables | same data, keyed by repo id and `codeCommit` |
| `nebula` | native tags `code_symbol`, `code_file` and edges `IMPORTS`, `CALLS`, `CONTAINS`, `IMPORTS_REPO` | vertex ids are the graph node hashes; `CONTAINS` carries file→symbol and module→file containment so the full edge set round-trips |

`codegraph/` is **generated data, never hand-edited**. It is not a zone ([01-brain-repo.md](01-brain-repo.md#brain-layout)): it is not a target for `thoughts new`, is skipped by the walk of `lint` and `scan` ([15](15-secret-scanning.md#what-is-scanned)), excluded from `thoughts search`, and excluded from index/log generation. `thoughts scan --fix` and the secret scanner never touch it; generated files do not need scanning, and code is the repo's business, not the brain's.

## Generated `index.md`

`repos/<repo-id>/codegraph/index.md` is a human/assistant-readable summary regenerated with the graph: module list, exported symbols per file, and the cross-repo dependency list. Deterministic like every generated file ([03-cli-sync.md](03-cli-sync.md#behaviour)). It exists so an assistant browsing `thoughts/repos/orders-service/` sees structure without a tool call.

## When the graph is built

- **At `init`** for the attaching repo, if grammars load.
- **Incrementally at `sync`** ([03](03-cli-sync.md#behaviour)): the CLI diffs the stored `codeCommit` against the repo's `HEAD`. Files whose content sha changed are re-extracted; unchanged files keep their nodes and edges.
- **Full rebuild** when the diff exceeds **500 changed files** or `meta.yml` / stored meta is missing or unreadable.
- **Fail soft, exactly one warning**: any grammar load, parse, or extraction failure means the whole codegraph step is skipped for that repo with **exactly one warning** (once per process, naming the cause) and `sync` continues. This mirrors the `auto` wording of [05-cli-search.md](05-cli-search.md#backends). A broken graph must never fail a sync.

## Cross-repo edges

`imports_repo` edges are computed at **brain level**, not per repo: a repo's `module` nodes are matched against sibling repos' package names. To make matching reliable, `brain.yml` gains an optional field:

```yaml
repos:
  - id: orders-service
    remote: git@github.com:acme/orders-service.git
    package: @acme/orders-service   # optional; matching fails soft when absent
```

If neither `package` nor the sibling's manifest yields a name, no edge is made — no warning, no error. Cross-repo edges are recomputed at `sync` after any repo's graph changes.

## Staleness

A repo's graph is:

- **fresh** — stored `codeCommit` equals repo `HEAD`,
- **stale — n commits ahead** — repo `HEAD` is `n` commits past the stored `codeCommit`,
- **absent** — no graph (never built, or grammars unavailable).

Staleness is computed from git only; it never triggers parsing at status time.

## Status integration

[`thoughts status`](04-cli-status.md) gains a **Codegraph** section: per repo a line of `files · symbols · edges` plus the staleness word from above, and a cross-repo list of `imports_repo` deps touching the current repo. `--json` adds a `graph` array (per repo: `files`, `symbols`, `edges`, `staleness`, `codeCommit`); `--no-graph` skips the section.

## Acceptance criteria

- Same tree at the same commit → `graph.json` byte-identical across runs and machines.
- Editing one file and syncing → only that file's nodes/edges change; `meta.yml` `codeCommit` moves to HEAD.
- 501-file change → full rebuild, one log line, sync still exit 0.
- `web-tree-sitter` removed from `node_modules` → `sync` prints exactly one warning, exits 0, graph stays as-is (or absent).
- Repo A imports `@acme/payments-api`, which is `package:` of repo B → after sync, `imports_repo` edge exists and `status` shows it; removing the `package` field makes the edge disappear on the next sync without any error.
- `codegraph/` files never appear in `thoughts search` results, `index.md`/`log.md` output, or scanner findings.
- Repo with no graph (never built) → status shows `absent`, nothing else changes.

## Open questions

- Should `calls` edges resolve cross-file in v1? Intra-file only keeps the grammar work tractable; cross-file needs a real symbol table and is the step up to a language server. Decide when someone needs it.
- Is `meta.yml` worth its file for the git backend, or should `codeCommit` live in `graph.json`? A separate file makes the staleness check a one-file read; leaning separate.
- Symbol granularity for v1: top-level declarations only, or nested methods too? Nested inflates the graph on large repos; leaning top-level plus one nesting level.
- Should `codegraph` ingest the brain's own templates/scripts? No in v1 — the graph is about code repos.
