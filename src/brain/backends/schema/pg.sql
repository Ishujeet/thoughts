-- thoughts psql brain schema (specs/16 "Provisioning", specs/17 "Storage").
-- Applied by `thoughts init` (connect + provision) and shipped with the CLI
-- as src/brain/backends/schema/pg.sql. Every statement is idempotent so
-- re-running provisioning is a no-op.
--
-- Representation (specs/16 "Representation", D22): the OKF document is the
-- canonical unit, but the store representation MUST be native — filterable
-- frontmatter fields as real columns, the full frontmatter as `jsonb`, the
-- body as text, plus full-text indexing. A single markdown column is
-- non-conforming. The `document` column below is NOT that dump: it is the
-- byte-exact copy of the canonical OKF document kept so the workspace can be
-- rematerialised without reformatting anyone's YAML (comments, key order,
-- quoting). Every query path uses the columns / jsonb / the FTS index.
--
-- Conventions: one database holds one brain. `revision` is a per-brain,
-- monotonically increasing integer (meta.rev); every row a commit writes
-- carries the revision it was written at, which is the base of the
-- optimistic-concurrency check (specs/16 sync table) and of pull.

-- Schema version row (specs/16 "Provisioning"): provision() reads this first
-- and applies only what is missing.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Thoughts (specs/16 "Representation")
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS thoughts (
    path            text PRIMARY KEY,                -- bundle-relative, no leading slash
    id              text NOT NULL,                   -- stable store id: sha256(brain id + "\n" + path)
    repo_id         text,                            -- owning repo id / `shared` / `user:<id>`
    kind            text,                            -- kind directory name (`specs`, `plans`, ...)
    zone            text,                            -- shared | repos | users
    title           text,
    status          text,                            -- draft | stable | deprecated
    created         timestamptz,
    updated         timestamptz,
    supersedes      text,                            -- bundle-relative path of the superseded thought
    superseded_by   text,
    stale_after     timestamptz,
    frontmatter     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the FULL frontmatter, unknown fields included
    body            text NOT NULL DEFAULT '',        -- markdown after the closing `---`
    document        text NOT NULL,                   -- byte-exact OKF document (workspace materialisation)
    revision        bigint NOT NULL,                 -- store revision that last wrote this row
    author          text
);

CREATE INDEX IF NOT EXISTS thoughts_by_repo ON thoughts (repo_id, kind);
CREATE INDEX IF NOT EXISTS thoughts_by_zone ON thoughts (zone, kind);
CREATE INDEX IF NOT EXISTS thoughts_by_status ON thoughts (status);
CREATE INDEX IF NOT EXISTS thoughts_by_revision ON thoughts (revision);

-- Serving (specs/16 Representation rule 3): queries hit the columns above and
-- this FTS index over title + body; a psql brain never answers a queryable
-- question by walking markdown.
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS search tsvector
    GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        to_tsvector('english', coalesce(body, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS thoughts_fts ON thoughts USING gin (search);

-- ---------------------------------------------------------------------------
-- History: append-only, the analogue of git history (specs/16 sync table).
-- Every write appends one row per changed thought with the full document, so
-- `read(path, {revision})` and `scan --history` work without the workspace.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS history (
    path        text NOT NULL,
    revision    bigint NOT NULL,
    author      text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    document    text NOT NULL,
    PRIMARY KEY (path, revision)
);

CREATE INDEX IF NOT EXISTS history_by_revision ON history (revision);

-- ---------------------------------------------------------------------------
-- Bounded change log (specs/16 log.md regeneration, specs/03 log format).
-- One row per change per revision: the ledger pull() replays to the workspace
-- and the source `log.md` is regenerated from. Pruned to the newest rows so
-- it stays bounded; it is a change log, not the full `history`.
-- `log_entries` is the specs/16 provisioning name for the same data.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS change_log (
    path        text NOT NULL,
    revision    bigint NOT NULL,
    change      text NOT NULL,                       -- added | updated | removed
    title       text,
    by          text,
    note        text,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (path, revision)
);

CREATE VIEW IF NOT EXISTS log_entries AS
    SELECT path, revision, change, title, by, note, occurred_at FROM change_log;

CREATE TABLE IF NOT EXISTS commits (
    id          bigint PRIMARY KEY,                  -- the revision the message belongs to
    message     text NOT NULL,
    author      text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Store metadata. Never a credential: brain.yml, the revision counter and the
-- brain descriptor (specs/16 "brain.yml backend block" carries names only).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
    key   text PRIMARY KEY,
    value jsonb NOT NULL
);

-- Seed revision: an empty store is at revision 1, like a git brain's root commit.
INSERT INTO meta (key, value) VALUES ('rev', '1'::jsonb) ON CONFLICT (key) DO NOTHING;
INSERT INTO commits (id, message, author) VALUES (1, 'seed', 'thoughts') ON CONFLICT (id) DO NOTHING;
INSERT INTO schema_migrations (version) VALUES ('0001') ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Workspace files that are not concepts (specs/01 layout): brain.yml,
-- generated index.md / log.md, `.thoughts-allow.yml`, codegraph index.md.
-- Concept rows live in `thoughts`; the generated graph itself lives in the
-- codegraph_* tables below; everything else materialises from here.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bundle_files (
    path       text PRIMARY KEY,
    document   text NOT NULL,
    revision   bigint NOT NULL
);

-- ---------------------------------------------------------------------------
-- Codegraph (specs/17 "Storage", D23): the generated graph of one repo, keyed
-- by repo id. `ord` preserves the canonical node/edge order of the document so
-- a round-trip through the tables is byte-identical.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS codegraph_nodes (
    repo_id  text NOT NULL,
    id       text NOT NULL,
    kind     text NOT NULL,
    name     text NOT NULL,
    file     text,
    sha      text,
    ord      integer NOT NULL,
    props    jsonb NOT NULL,                          -- the full node object
    PRIMARY KEY (repo_id, id)
);

CREATE TABLE IF NOT EXISTS codegraph_edges (
    repo_id  text NOT NULL,
    id       text NOT NULL,
    type     text NOT NULL,
    source   text NOT NULL,
    target   text NOT NULL,
    ord      integer NOT NULL,
    props    jsonb NOT NULL,                          -- the full edge object
    PRIMARY KEY (repo_id, id)
);

CREATE TABLE IF NOT EXISTS codegraph_meta (
    repo_id   text PRIMARY KEY,
    code_commit text,
    document  text NOT NULL,                          -- meta.yml as generated
    revision  bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS codegraph_nodes_by_repo ON codegraph_nodes (repo_id, ord);
CREATE INDEX IF NOT EXISTS codegraph_edges_by_repo ON codegraph_edges (repo_id, ord);
