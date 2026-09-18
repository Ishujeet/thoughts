# 16 — Brain backends

Status: Draft

## Purpose

Define what a brain is *stored in*. Until now a brain has been "a plain git repository" (D22 amends [00-overview.md](00-overview.md) G4). From this spec on, a brain has a **backend**: the durable store and sync transport, chosen once at `init`. Git remains the default and the only backend that works with no server. Thoughts stay OKF markdown in every backend — that is the non-negotiable.

## Backend kinds

| Kind | Store of record | Sync transport | Thoughts on disk as |
|------|-----------------|----------------|---------------------|
| `git` (default) | A git repository (remote or local path) | `git pull --rebase` / `git push` | OKF markdown files |
| `psql` | A PostgreSQL database | SQL over one connection | OKF markdown documents in a `thoughts` table |
| `nebula` | A NebulaGraph space | nGQL statements | OKF markdown as properties of `thought` vertices |

Selection: `--backend git|psql|nebula` and `--connection-ref <ref>` on [`thoughts init`](02-cli-init.md), or an interactive select prompt added to the common section of the init guide (D15). Default is `git`. `--yes` with a non-git backend and no `--connection-ref` MUST exit 1 naming the env var the user must provide.

## Representation

The backend is the store and transport, **not** the data model. Four rules fix how a thought may be represented at each layer; they exist so each backend uses its native strengths (the reason to pick it) without forking the data model into three products.

1. **Canonical unit: the OKF document, in every backend.** A thought round-trips losslessly between any backend and the workspace as the same `.md` file with YAML frontmatter ([09](09-index-metadata-okf.md)). This is D22's "thoughts stay OKF markdown in every backend".
2. **Store representation: native per backend, MUST NOT be a markdown dump.** Storing thought text verbatim in a single column or property is non-conforming for psql and nebula:
   - `psql`: filterable frontmatter fields live as real columns (`kind`, `zone`, `repo_id`, `title`, `status`, timestamps), the full frontmatter as `jsonb`, the body as text, plus FTS indexing.
   - `nebula`: frontmatter fields as `thought` vertex properties; relations between thoughts as edges (`LINKS_TO`, `SUPERSEDES`), not as links buried in body text.
   - `git`: OKF markdown files — here the file *is* the native representation.
3. **Serving: SHOULD use the backend's native index, never a file walk where a query exists.** Token cost is decided by what gets served, not by what is stored. `search` ([05](05-cli-search.md)), `status` ([04](04-cli-status.md)), and every `--json` output query the backend's own structures — psql: column filters and FTS, returning only matched documents and snippets; nebula: graph traversals (`LOOKUP`, `GO FROM … OVER`), returning only matched vertices; git: walks and parses the workspace, as today. A psql or nebula brain MUST NOT answer a queryable question by walking markdown.
4. **Workspace: the agent's materialised view, in every backend.** `<repo>/thoughts/…` serves the same OKF markdown regardless of backend ([Workspace vs store](#workspace-vs-store)). Agents never learn the backend; queries never leak into the kit.

Consequence: the standard kit and adapters are unchanged by backend choice; the performance and token characteristics are not. A psql brain serves `status --json` from a query, not from a thousand file reads.

## Workspace vs store

The working set is **identical for all backends**:

- `~/.thoughts/brains/<brain-id>/` is the local workspace — an ordinary directory with the full layout from [01-brain-repo.md](01-brain-repo.md#brain-layout), holding OKF markdown.
- For `git` the workspace is *also* the store clone, as today. For `psql` and `nebula` the workspace is a plain checkout-like directory the CLI materialises from the store and writes back to.
- Every tool that reads `<repo>/thoughts/...` reads markdown in every backend. Nothing in the standard kit ([08](08-standard-kit.md)) or the adapters ([11](11-ai-tool-adapters.md)) knows which backend is in use.
- The store is authoritative for a backend's own conflict semantics; the workspace is disposable and MUST be fully rebuildable from the store (for `git`, `git clone`; for the others, a full read).

## `brain.yml` backend block

`brain.yml` gains a **non-secret descriptor**:

```yaml
backend:
  kind: psql            # git | psql | nebula
  database: acme_brain  # psql only
  space: acme_brain     # nebula only
```

- `kind: git` MAY omit the rest; the git remote stays where it is today (`.thoughts.yml` `brain:` value / global config), so existing brains are unchanged.
- `brain.yml` MUST NOT contain a connection string, password, or host credential. Only the names of database/space objects. The scanner ([15-secret-scanning.md](15-secret-scanning.md)) MUST treat a connection string in `brain.yml` or `.thoughts.yml` as a block-severity finding (kind: *database connection string*).

## Credential references

Connection details NEVER live in the brain or in any committed file. They follow the [10-integrations.md](10-integrations.md) credential contract (credentials outside the brain, referenced from global config), written as a **cred-ref**:

- `env:VAR` — name of an environment variable holding the connection string or URL.
- `keyref:name` — an entry in the OS keychain, stored by the CLI.

The ref is resolved from `~/.config/thoughts/config.yml` at connect time. Committed files carry only the ref. `<repo>/.thoughts.yml` `brain:` value gains two schemes:

```yaml
brain: git@github.com:acme/acme-brain.git   # git backend, as today
brain: postgres:acme-brain                  # psql backend, brain id after the scheme
brain: nebula:acme-brain                    # nebula backend
```

Brain-id derivation (`brainIdFromRemote`) becomes scheme-aware: `postgres:<id>` and `nebula:<id>` yield `<id>` directly; a git URL yields the repo name as today. Resolution precedence: `.thoughts.yml` → `--brain` → global config → prompt, unchanged from [02-cli-init.md](02-cli-init.md#steps).

## Provisioning

`init` step 1 becomes **connect + provision** for non-git backends, then materialises the workspace. Schema files ship with the CLI (`src/brain/backends/schema/pg.sql`, `src/brain/backends/schema/nebula.ngql`).

- **git** — clone or scaffold as [02-cli-init.md](02-cli-init.md#1-resolve-the-brain) says today. No change.
- **psql** — connect, then create if absent: `thoughts`, `log_entries`, `history`, `meta`, plus the codegraph tables of [17-codegraph.md](17-codegraph.md#storage). If the server is unreachable or the credentials fail, `init` prints a **ready-to-run docker snippet** — written to `~/.thoughts/backends/<brain-id>/docker-compose.yml` and echoed to the terminal — and exits 2. The snippet is CLI-owned output, a convenience, never something `init` starts itself.
- **nebula** — `CREATE SPACE` (if absent) with a fixed partition/replica default, then `CREATE TAG` / `CREATE EDGE` for the thought schema and the codegraph tags/edges of [17-codegraph.md](17-codegraph.md#storage). Same unreachable behaviour: snippet, exit 2.

Per-step mapping for the [02](02-cli-init.md) guide: preflight adds backend reachability; step 1 = connect + provision + materialise workspace; the pre-commit secret hook is **git-only** (non-git stores have no hook to install — scanning happens inside `sync` instead, [15](15-secret-scanning.md#where-the-scan-runs)); step 8's "initial sync" becomes "store seeded". `StepReport` gains backend rows; a connection ref is shown only as `env:<NAME>`, never its value.

## Sync and conflict semantics

`thoughts sync` ([03](03-cli-sync.md)) keeps its step order (scan → validate → regenerate → commit-to-store → pull → push → reindex → codegraph → report). The store steps differ per backend:

| Kind | Write | Conflict detection | On conflict |
|------|-------|--------------------|-------------|
| `git` | `git commit` + `git push` | rebase | Stop, exit 4; generated files auto-resolve; user resolves concept files with git ([03](03-cli-sync.md#conflict-handling)) |
| `psql` | One transaction under a PostgreSQL advisory lock (keyed by brain id), holding the write until commit | `base_rev` optimistic check: each written thought carries the revision it was read at; a mismatch aborts the transaction | Roll back, exit 4, name the changed paths |
| `nebula` | Batched nGQL writes | none available | **Store wins.** The local change is overwritten; `sync` prints a warning and appends a note to `log.md` recording what was lost. Never silently. |

- `psql` history is an **append-only `history` table** (path, revision, author, timestamp, full document) — the analogue of git history for `scan --history` ([15](15-secret-scanning.md#if-a-secret-was-already-pushed)).
- `nebula` keeps a bounded change log in the same store for `log.md` regeneration; it is not a full history, and `scan --history` on a nebula brain MUST say so rather than pretend.
- Pull semantics: `git` rebases onto remote commits; `psql` reads rows with revision > the workspace's `meta.last_rev`; `nebula` re-reads the space's thought vertices.

## Failure modes and exit codes

Exit codes are shared with the existing specs and unchanged:

| Code | Meaning | Examples |
|------|---------|----------|
| 2 | Store unreachable | git clone/fetch failed; psql/nebula refused the connection ([02](02-cli-init.md#exit-codes), [03](03-cli-sync.md#exit-codes)) |
| 4 | Conflict requires manual resolution | git rebase conflict; psql `base_rev` mismatch |
| 7 | Secret found | unchanged, all backends |
| 1 | Validation / configuration error | non-git backend without a connection ref under `--yes` |

Fail soft (principle 5, [00](00-overview.md)): an unreachable store MUST NOT lose local work. `psql`/`nebula` `sync` with an unreachable store leaves the change in the workspace, exits 2, and the next successful `sync` writes it — the same contract as git's offline commit today.

## Backend is immutable in v1

A brain's backend is chosen at `init` and MUST NOT change afterwards in v1. There is no `thoughts backend migrate`. Rationale and the migration question are in Open questions below.

## Acceptance criteria

- `init --backend git` on a fresh repo produces byte-identical results to today's `init`; existing brains keep working with no `backend:` block in `brain.yml`.
- `init --backend psql --connection-ref env:BRAIN_PG` provisions the tables, materialises `~/.thoughts/brains/<id>/` with OKF markdown, and `thoughts sync` round-trips a thought from two machines.
- `init --yes --backend psql` without a connection ref → exit 1 naming the env var; nothing provisioned.
- psql server down → exit 2, docker snippet written to `~/.thoughts/backends/<brain-id>/docker-compose.yml`, local edit still present in the workspace.
- Two machines write the same psql thought concurrently → second `sync` exits 4 naming the path; no partial write is visible.
- Two machines write the same nebula thought concurrently → second `sync` finishes with a warning and a `log.md` note; the store's version wins.
- `grep -r postgres:// ~/.thoughts/brains/<id>/` never yields a password: refs only, enforced by the scanner.
- Every command that reads thoughts works against a psql or nebula brain with no tool-visible difference in the markdown it serves.
- Representation conformance ([Representation](#representation)): the psql schema has frontmatter fields as columns/`jsonb` (not one text blob); `thoughts status --json` against a psql or nebula brain issues zero workspace file reads for the thought rows it reports.

## Open questions

- May a brain be migrated between backends? Recommendation: **not in v1, backend immutable after init.** A migration tool would have to translate history and conflict semantics, which is where the backends genuinely differ; get one release of real use first.
- Nebula property-size limits on thought bodies — decide after first contact. If a body exceeds the limit, the fallback shape (chunked properties vs. an external blob store) is undecided until we know the real bound.
- Should the psql advisory lock key be derived from the brain id or from the database name? Either works; pick one before two brains share a cluster.
- Does `nebula` need a `meta` vertex equivalent, or can workspace-side `meta.yml` carry `last_rev`? Leaning workspace-side.
