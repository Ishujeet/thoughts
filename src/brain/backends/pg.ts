/**
 * The psql backend (specs/16): a PostgreSQL database is the store of record,
 * SQL over one connection is the transport, and `~/.thoughts/brains/<id>/` is
 * the materialised OKF view the CLI writes back to.
 *
 * Representation (specs/16 "Representation", D22): the OKF document is the
 * canonical unit, and the store represents it natively — filterable
 * frontmatter fields as real columns, the full frontmatter as `jsonb`, the
 * body as text, plus a generated `tsvector` over title + body (schema/pg.sql).
 * A single markdown column is non-conforming. The `document` column is not
 * that dump: it is the byte-exact copy of the canonical OKF document so the
 * workspace materialises back without reformatting anyone's frontmatter; every
 * query path uses the columns, `jsonb` and the FTS index.
 *
 * Conflict semantics (specs/16 sync table, psql row): each written thought
 * carries the revision it was read at; a mismatch aborts the whole transaction
 * (exit 4, naming the paths — never silent, never a partial write).
 * Pull semantics (specs/16 pull table): rows with `revision >` the workspace
 * `meta.yml` `last_rev`.
 *
 * The driver is an optional dependency imported lazily, so a missing `pg`
 * degrades into a named error. Tests drive this class through the `client` /
 * `connect` seams — no server, and no behaviour difference.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetPath } from '../../assets.js';
import { locate } from '../location.js';
import { parseFrontmatter } from '../okf.js';
import { listWorkspaceThoughts, readWorkspaceFile, writeWorkspaceFile } from './workspace.js';
import { maskConnectionString, resolveCredRef, DEFAULT_PG_CONNECTION_ENV } from './credref.js';
import {
  conflictError,
  type BackendHealth,
  type BrainBackend,
  type ConflictContext,
  type ConflictInfo,
  type PushInput,
  type PushResult,
  type StoreChange,
  type WorkspaceChange,
} from './types.js';
import { ExitCode, ThoughtsError, type LogEntry } from '../../types.js';

/** The slice of `pg.Client` this backend uses; fakes implement exactly this. */
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect?(): Promise<void>;
  end?(): Promise<void>;
}

/** Every statement starts with its seam tag so a fake client can dispatch. */
function tag(op: string): string {
  return `-- thoughts:${op}\n`;
}

interface PgModule {
  default?: { Client?: new (opts: { connectionString: string }) => PgClientLike };
  Client?: new (opts: { connectionString: string }) => PgClientLike;
}

/** Version the shipped DDL records in `schema_migrations`. */
export const PG_SCHEMA_VERSION = '0001';

/**
 * The change log is bounded (specs/16): the newest rows are kept, older ones
 * are pruned at commit. It is a change log for `log.md` regeneration and pull
 * replays, not the full history — `history` is append-only for that.
 */
export const CHANGE_LOG_LIMIT = 10_000;

export const PRUNE_CHANGE_LOG_SQL =
  'DELETE FROM change_log WHERE (path, revision) NOT IN (SELECT path, revision FROM change_log ORDER BY revision DESC, path LIMIT $1)';

// ---------------------------------------------------------------------------
// Native representation (specs/16 Representation, D22)
// ---------------------------------------------------------------------------

const THOUGHT_COLUMNS =
  'path, id, repo_id, kind, zone, title, status, created, updated, supersedes, superseded_by, stale_after, frontmatter, body, document, revision, author';

/** FTS expression over title + body — the same one the schema indexes. */
export const FTS_EXPRESSION = "setweight(to_tsvector('english', coalesce(title, '')), 'A') || to_tsvector('english', coalesce(body, ''))";

/** A query against the thoughts table: column filters + FTS, never a walk. */
export interface ThoughtQuery {
  /** Full text over title + body. */
  text?: string;
  repoId?: string;
  zone?: string;
  kind?: string;
  status?: string;
  /** `revision > sinceRevision` — the pull filter (specs/16 pull table). */
  sinceRevision?: number | string;
  limit?: number;
}

/**
 * Build the SQL a native-index query runs. Exported for the
 * query-construction tests; `searchThoughts` is the only runtime caller.
 */
export function buildThoughtQuery(q: ThoughtQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    where.push(fragment.replace('$?', `$${params.length}`));
  };
  if (q.repoId !== undefined) add('repo_id = $?', q.repoId);
  if (q.zone !== undefined) add('zone = $?', q.zone);
  if (q.kind !== undefined) add('kind = $?', q.kind);
  if (q.status !== undefined) add('status = $?', q.status);
  if (q.sinceRevision !== undefined) add('revision > $?', Number(q.sinceRevision));
  if (q.text !== undefined && q.text.trim().length > 0) add(`(${FTS_EXPRESSION}) @@ websearch_to_tsquery('english', $?)`, q.text.trim());
  const limit = q.limit !== undefined && q.limit > 0 ? ` LIMIT ${Math.floor(q.limit)}` : '';
  const sql =
    tag('search') +
    `SELECT ${THOUGHT_COLUMNS} FROM thoughts` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY revision DESC, path' +
    limit;
  return { sql, params };
}

/** One row of the `thoughts` table, as this backend reads and writes it. */
export interface ThoughtRow {
  path: string;
  id: string;
  repo_id: string | null;
  kind: string | null;
  zone: string | null;
  title: string | null;
  status: string | null;
  created: string | null;
  updated: string | null;
  supersedes: string | null;
  superseded_by: string | null;
  stale_after: string | null;
  frontmatter: unknown;
  body: string;
  document: string;
  revision: number | string;
  author: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Split one OKF document into its native row (columns + `jsonb` + body). */
export function docToRow(relPath: string, doc: string, revision: number, author: string | undefined, brainId: string, now: Date): ThoughtRow {
  const parsed = parseFrontmatter(doc);
  const fm: Record<string, unknown> = isRecord(parsed.frontmatter) ? parsed.frontmatter : {};
  const loc = locate('/' + relPath.replace(/^\/+/, ''));
  const generated = isRecord(fm['generated']) ? (fm['generated'] as Record<string, unknown>) : {};
  const created = str(generated['at']) ?? now.toISOString();
  return {
    path: relPath,
    id: thoughtId(brainId, relPath),
    repo_id: str(fm['repo']) ?? loc?.owner ?? null,
    kind: loc?.kind ?? null,
    zone: loc?.zone ?? null,
    title: str(fm['title']),
    status: str(fm['status']),
    created: created,
    updated: now.toISOString(),
    supersedes: str(fm['supersedes']),
    superseded_by: str(fm['superseded_by']),
    stale_after: str(fm['stale_after']),
    frontmatter: fm,
    body: parsed.body,
    document: doc,
    revision,
    author: author ?? null,
  };
}

/** Stable store id of a thought: hash of brain id + path (specs/17 style). */
export function thoughtId(brainId: string, relPath: string): string {
  return createHash('sha256').update(`${brainId}\n${relPath}`, 'utf8').digest('hex');
}

/**
 * Rebuild the OKF document from the native columns (frontmatter `jsonb` +
 * body). The byte-exact `document` column wins when present; this is the
 * fallback that proves the columns carry the whole document.
 */
export function rowToDoc(row: ThoughtRow): string {
  if (typeof row.document === 'string' && row.document.length > 0) return row.document;
  const fm = isRecord(row.frontmatter) ? (row.frontmatter as Record<string, unknown>) : {};
  const lines = Object.entries(fm).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n${row.body ?? ''}`;
}

// ---------------------------------------------------------------------------
// Workspace state (specs/16: the workspace carries last_rev)
// ---------------------------------------------------------------------------

const META_FILE = 'meta.yml';

interface FileStamp {
  mtime: number;
  size: number;
  sha: string;
  /** Store revision this file was materialised at. */
  rev: number;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * What the workspace holds for a tracked path, read as cheaply as possible:
 * `read` is false when the materialisation stamp still matches, so a clean
 * workspace is compared with zero file content reads (specs/16 acceptance).
 */
interface LocalDoc {
  /** True when the file content itself was read (or the file is gone). */
  read: boolean;
  value: string | undefined;
}

// ---------------------------------------------------------------------------
// PgBackend
// ---------------------------------------------------------------------------

export interface PgBackendOptions {
  brainId: string;
  workspace: string;
  /** Cred-ref (specs/10): `env:VAR` or `keyref:name`. Never a connection string. */
  connectionRef?: string;
  /** psql only: the database name (specs/16 brain.yml backend block). */
  database?: string;
  /** Test seam: an already-connected client. */
  client?: PgClientLike;
  /** Test seam: connect with the resolved connection string. */
  connect?: (connectionString: string) => Promise<PgClientLike>;
  now?: () => Date;
  author?: string;
}

interface StoreSnapshot {
  thoughts: Map<string, string>;
  files: Map<string, string>;
  revs: Map<string, number>;
}

export class PgBackend implements BrainBackend {
  readonly kind = 'psql' as const;
  readonly brainId: string;
  readonly workspace: string;
  readonly connectionRef: string | undefined;

  private readonly opts: PgBackendOptions;
  private readonly database: string | undefined;
  private client: PgClientLike | undefined;
  private connecting: Promise<PgClientLike> | undefined;
  private metaLoaded = false;
  private lastRev = 0;
  /**
   * The revision `commit()` created, kept for `push` (specs/16): the log
   * entries attach to the revision this workspace wrote, even when an
   * intervening `pull` has advanced `lastRev` past it.
   */
  private commitRev: number | undefined;
  private readonly stamps = new Map<string, FileStamp>();
  /** Workspace-relative paths this run changed. */
  private readonly pending = new Map<string, 'written' | 'deleted'>();
  private readonly pendingDocs = new Map<string, string>();
  /** Store revision of each pending path when this backend last read it. */
  private readonly base = new Map<string, number>();
  /** Paths a commit or pull refused because the store had moved on. */
  private conflicted: string[] = [];

  constructor(opts: PgBackendOptions) {
    this.opts = opts;
    this.brainId = opts.brainId;
    this.workspace = opts.workspace;
    this.connectionRef = opts.connectionRef;
    this.database = opts.database;
  }

  // -- connection ----------------------------------------------------------

  private async clientOrThrow(): Promise<PgClientLike> {
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = this.connect();
    try {
      this.client = await this.connecting;
    } finally {
      this.connecting = undefined;
    }
    return this.client;
  }

  private async connect(): Promise<PgClientLike> {
    if (this.opts.client) return this.opts.client;
    const connectionString = await this.connectionString();
    try {
      if (this.opts.connect) return await this.opts.connect(connectionString);
      const specifier = 'pg';
      const mod = (await import(specifier)) as PgModule;
      const Client = mod.default?.Client ?? mod.Client;
      if (typeof Client !== 'function') throw new Error('the pg module has no Client export');
      const client = new Client({ connectionString });
      await client.connect?.();
      return client;
    } catch (err) {
      if (err instanceof ThoughtsError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(message)) {
        throw new ThoughtsError('the PostgreSQL driver is not installed', ExitCode.Validation, {
          hint: 'the driver is an optional dependency: npm install pg   (git brains need no driver)',
          cause: err,
        });
      }
      // Never echo a connection string (specs/16): diagnostics are masked.
      throw new ThoughtsError(`psql brain "${this.brainId}" is unreachable: ${maskConnectionString(message)}`, ExitCode.RemoteUnreachable, {
        hint: 'check the connection reference and that the server is running, then re-run',
        cause: err,
      });
    }
  }

  /**
   * The connection string behind the cred-ref (specs/10). Never printed,
   * never stored: this is the only place it is held in memory.
   */
  private async connectionString(): Promise<string> {
    const ref = this.connectionRef;
    if (ref === undefined || ref.trim().length === 0) {
      throw new ThoughtsError(`psql brain "${this.brainId}" has no connection reference`, ExitCode.Validation, {
        hint: `pass --connection-ref env:${DEFAULT_PG_CONNECTION_ENV} and set that environment variable to the connection string`,
      });
    }
    return resolveCredRef(ref);
  }

  /**
   * The non-secret object name this store lives in (specs/16 brain.yml block)
   * — the seam `init` provisions through (ProvisionableBackend).
   */
  async storeName(): Promise<string> {
    return this.databaseName();
  }

  /**
   * The database name the connection string points at — the only part of it
   * that may be written down (specs/16 "brain.yml backend block"). Defaults to
   * the brain id with `-` folded to `_`.
   */
  async databaseName(): Promise<string> {
    if (this.opts.database !== undefined && this.opts.database.length > 0) return this.opts.database;
    const cs = await this.connectionString();
    const url = /^postgres(ql)?:\/\//i.exec(cs);
    if (url) {
      try {
        const parsed = new URL(cs);
        const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
        if (db.length > 0) return db;
      } catch {
        // fall through to the DSN form
      }
    }
    const dsn = /(?:^|\s)dbname\s*=\s*(\S+)/i.exec(cs)?.[1];
    if (dsn !== undefined) return dsn;
    return this.brainId.replace(/[^A-Za-z0-9_]/g, '_');
  }

  /** Apply `schema/pg.sql` (specs/16 "Provisioning"). Idempotent. */
  async provision(): Promise<{ applied: boolean; version: string }> {
    const client = await this.clientOrThrow();
    const ddl = loadPgSchema();
    for (const statement of splitSqlStatements(ddl)) await client.query(statement, []);
    return { applied: true, version: PG_SCHEMA_VERSION };
  }

  // -- workspace state -----------------------------------------------------

  /** Load `meta.yml` (last_rev + materialisation stamps). One small read. */
  private async loadWorkspaceMeta(): Promise<void> {
    if (this.metaLoaded) return;
    this.metaLoaded = true;
    const text = await readWorkspaceFile(this.workspace, META_FILE);
    if (text === undefined) return;
    const YAML = (await import('yaml')).default;
    let parsed: unknown;
    try {
      parsed = YAML.parse(text);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (typeof parsed['last_rev'] === 'number') this.lastRev = parsed['last_rev'];
    const files = parsed['files'];
    if (!isRecord(files)) return;
    for (const [rel, stamp] of Object.entries(files)) {
      if (!isRecord(stamp)) continue;
      if (typeof stamp['mtime'] !== 'number' || typeof stamp['size'] !== 'number' || typeof stamp['sha'] !== 'string') continue;
      this.stamps.set(rel, { mtime: stamp.mtime, size: stamp.size, sha: stamp.sha, rev: typeof stamp['rev'] === 'number' ? stamp.rev : 0 });
    }
  }

  private async saveWorkspaceMeta(): Promise<void> {
    const files: Record<string, FileStamp> = {};
    for (const [rel, stamp] of [...this.stamps.entries()].sort(([a], [b]) => a.localeCompare(b))) files[rel] = stamp;
    const YAML = (await import('yaml')).default;
    await writeWorkspaceFile(this.workspace, META_FILE, YAML.stringify({ backend: 'psql', last_rev: this.lastRev, files }, { lineWidth: 0 }));
  }

  private async stamp(rel: string, rev: number, doc?: string): Promise<void> {
    try {
      const st = await fs.promises.stat(path.join(this.workspace, rel));
      const content = doc !== undefined ? doc : (await readWorkspaceFile(this.workspace, rel)) ?? '';
      this.stamps.set(rel, { mtime: st.mtimeMs, size: st.size, sha: sha256(content), rev });
    } catch {
      this.stamps.delete(rel);
    }
  }

  // -- store reads ---------------------------------------------------------

  private async headRev(): Promise<number> {
    const client = await this.clientOrThrow();
    const r = await client.query(tag('head') + "SELECT value::text AS value FROM meta WHERE key = 'rev'");
    const n = Number(r.rows[0]?.['value']);
    return Number.isFinite(n) ? n : 0;
  }

  private async storeSnapshot(): Promise<StoreSnapshot> {
    const client = await this.clientOrThrow();
    const snapshot: StoreSnapshot = { thoughts: new Map(), files: new Map(), revs: new Map() };
    const thoughts = await client.query(tag('rows_all') + 'SELECT path, document, revision FROM thoughts ORDER BY path');
    for (const row of thoughts.rows) {
      const p = String(row['path']);
      snapshot.thoughts.set(p, String(row['document']));
      snapshot.revs.set(p, Number(row['revision']));
    }
    const files = await client.query(tag('files_all') + 'SELECT path, document, revision FROM bundle_files ORDER BY path');
    for (const row of files.rows) {
      const p = String(row['path']);
      snapshot.files.set(p, String(row['document']));
      snapshot.revs.set(p, Number(row['revision']));
    }
    return snapshot;
  }

  private async thoughtRow(relPath: string): Promise<ThoughtRow | undefined> {
    const client = await this.clientOrThrow();
    const r = await client.query(tag('row') + `SELECT ${THOUGHT_COLUMNS} FROM thoughts WHERE path = $1`, [relPath]);
    return r.rows[0] === undefined ? undefined : (r.rows[0] as unknown as ThoughtRow);
  }

  private async metaSet(key: string, value: string): Promise<void> {
    const client = await this.clientOrThrow();
    await client.query(
      tag('meta_set') + 'INSERT INTO meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, value],
    );
  }

  /** Store revision of one path, 0 when the store has none. */
  private async storeRevOf(rel: string): Promise<number> {
    try {
      const client = await this.clientOrThrow();
      const r = await client.query(tag('row_rev') + 'SELECT revision FROM thoughts WHERE path = $1', [rel]);
      const n = Number(r.rows[0]?.['revision']);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0; // unreachable: the base-revision check at commit decides
    }
  }

  /**
   * Materialise the workspace when the store is ahead of it (specs/16 "Workspace
   * vs store": the workspace is a checkout). Read paths degrade to the already
   * materialised files when the store is unreachable — fail soft, never a crash.
   */
  private async ensureMaterialised(): Promise<void> {
    await this.loadWorkspaceMeta();
    try {
      if (this.lastRev >= (await this.headRev())) return;
    } catch {
      return;
    }
    try {
      await this.pull(undefined);
    } catch (err) {
      // A store change under an uncommitted local edit is the conflict of
      // specs/16 — but materialising is a read-side step (status, dirty): it
      // must not overwrite the workspace mid-read. Leave the local edit in
      // place; the conflict surfaces at commit, where it is a sync outcome.
      if (err instanceof ThoughtsError && err.exitCode === ExitCode.Conflict) return;
      throw err;
    }
  }

  // -- BrainBackend --------------------------------------------------------

  async health(): Promise<BackendHealth> {
    try {
      const client = await this.clientOrThrow();
      await client.query(tag('ping') + 'SELECT 1 AS ok');
      return { ok: true, detail: this.database ? `psql ${this.database}` : 'psql' };
    } catch (err) {
      const detail = err instanceof ThoughtsError ? err.message : maskConnectionString(err instanceof Error ? err.message : String(err));
      return { ok: false, detail };
    }
  }

  /** Thought paths: store rows first, then this run's writes, then the workspace. */
  async listThoughts(): Promise<string[]> {
    const paths = new Set<string>();
    try {
      const client = await this.clientOrThrow();
      const r = await client.query(tag('paths') + 'SELECT path FROM thoughts ORDER BY path');
      for (const row of r.rows) paths.add(String(row['path']));
    } catch {
      // Store unreachable: the materialised workspace still answers (fail soft).
    }
    for (const [rel, kind] of this.pending) {
      if (kind === 'written') paths.add(rel);
      else paths.delete(rel);
    }
    for (const rel of await listWorkspaceThoughts(this.workspace)) paths.add(rel);
    return [...paths].sort();
  }

  async read(relPath: string, opts: { revision?: string } = {}): Promise<string | undefined> {
    const rel = relPath.replace(/^\/+/, '');
    await this.loadWorkspaceMeta();
    if (opts.revision !== undefined) {
      const client = await this.clientOrThrow();
      const rev = opts.revision === 'HEAD' ? await this.headRev() : Number(opts.revision);
      const r = await client.query(
        tag('row_at') + 'SELECT document FROM history WHERE path = $1 AND revision <= $2 ORDER BY revision DESC LIMIT 1',
        [rel, rev],
      );
      const doc = r.rows[0]?.['document'];
      return doc === undefined || doc === null ? undefined : String(doc);
    }
    const pending = this.pending.get(rel);
    if (pending === 'written') return (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel);
    if (pending === 'deleted') return undefined;
    try {
      const client = await this.clientOrThrow();
      const r = await client.query(tag('row') + `SELECT ${THOUGHT_COLUMNS} FROM thoughts WHERE path = $1`, [rel]);
      const doc = r.rows[0]?.['document'];
      if (doc !== undefined && doc !== null) return String(doc);
    } catch {
      // fall through to the materialised workspace
    }
    return readWorkspaceFile(this.workspace, rel);
  }

  async write(relPath: string, doc: string): Promise<void> {
    const rel = relPath.replace(/^\/+/, '');
    await this.loadWorkspaceMeta();
    if (!this.pending.has(rel)) this.base.set(rel, await this.storeRevOf(rel));
    this.pending.set(rel, 'written');
    this.pendingDocs.set(rel, doc);
    await writeWorkspaceFile(this.workspace, rel, doc);
    await this.stamp(rel, this.lastRev);
  }

  async delete(relPath: string): Promise<void> {
    const rel = relPath.replace(/^\/+/, '');
    await this.loadWorkspaceMeta();
    if (!this.pending.has(rel)) this.base.set(rel, await this.storeRevOf(rel));
    this.pending.set(rel, 'deleted');
    this.pendingDocs.delete(rel);
    this.stamps.delete(rel);
    await fs.promises.rm(path.join(this.workspace, rel), { force: true });
  }

  /**
   * The workspace against the store — the analogue of `git status`. File
   * contents are read only where a materialisation stamp no longer matches, so
   * a clean workspace costs zero thought reads.
   */
  async dirty(): Promise<WorkspaceChange[]> {
    await this.ensureMaterialised();
    let store: StoreSnapshot;
    try {
      store = await this.storeSnapshot();
    } catch {
      return []; // unreachable: nothing to compare against; local work is kept
    }
    const workspace = new Set(await listWorkspaceFiles(this.workspace));
    const paths = new Set<string>([...store.thoughts.keys(), ...store.files.keys(), ...workspace, ...this.pending.keys()]);
    const changes: WorkspaceChange[] = [];
    for (const rel of [...paths].sort()) {
      const kind = this.pending.get(rel);
      const remote = store.thoughts.get(rel) ?? store.files.get(rel);
      const remoteRev = store.revs.get(rel) ?? 0;
      if (kind !== undefined) {
        const doc = kind === 'written' ? (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel) : undefined;
        if (doc === remote) continue;
        changes.push({ path: rel, code: doc === undefined ? 'D' : remote === undefined ? 'A' : 'M', deleted: doc === undefined });
        continue;
      }
      const local = await this.localDoc(rel);
      const differs = local.read ? local.value !== remote : remoteRev > (this.stamps.get(rel)?.rev ?? 0);
      if (!differs) continue;
      const deleted = !workspace.has(rel);
      changes.push({ path: rel, code: deleted ? 'D' : remote === undefined ? 'A' : 'M', deleted });
    }
    return changes;
  }

  /**
   * The workspace copy of a tracked path, reading the file only when the
   * materialisation stamp no longer matches it.
   */
  private async localDoc(rel: string): Promise<LocalDoc> {
    const abs = path.join(this.workspace, rel);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
    } catch {
      return { read: true, value: undefined };
    }
    const stamp = this.stamps.get(rel);
    if (stamp !== undefined && stamp.mtime === st.mtimeMs && stamp.size === st.size) return { read: false, value: undefined };
    const content = await readWorkspaceFile(this.workspace, rel);
    if (stamp !== undefined && content !== undefined && sha256(content) === stamp.sha) {
      this.stamps.set(rel, { ...stamp, mtime: st.mtimeMs, size: st.size });
      return { read: false, value: undefined };
    }
    return { read: true, value: content };
  }

  /** The workspace position: the store revision this workspace has applied. */
  async revision(): Promise<string | undefined> {
    await this.loadWorkspaceMeta();
    return String(this.lastRev);
  }

  async upstreamRevision(): Promise<string | undefined> {
    await this.loadWorkspaceMeta();
    try {
      return String(await this.headRev());
    } catch {
      return undefined;
    }
  }

  /** The scheme ref a repo's `.thoughts.yml` carries — never a credential. */
  async remoteUrl(): Promise<string | undefined> {
    return `postgres:${this.brainId}`;
  }

  /** Workspace-vs-store diff between two store revisions, newest last. */
  async diff(from: string, to?: string): Promise<WorkspaceChange[]> {
    const client = await this.clientOrThrow();
    const a = Number(from);
    const b = to === undefined || to === 'HEAD' ? await this.headRev() : Number(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    const r = await client.query(
      tag('since_changes') + 'SELECT path, change, revision FROM change_log WHERE revision > $1 AND revision <= $2 ORDER BY revision, path',
      [a, b],
    );
    const byPath = new Map<string, WorkspaceChange>();
    for (const row of r.rows) {
      const change = String(row['change']);
      byPath.set(String(row['path']), {
        path: String(row['path']),
        code: change === 'removed' ? 'D' : change === 'added' ? 'A' : 'M',
        deleted: change === 'removed',
      });
    }
    return [...byPath.values()].sort((x, y) => x.path.localeCompare(y.path));
  }

  /**
   * Settle the workspace into the store: one transaction under the brain's
   * advisory lock, with the optimistic base-revision check of specs/16.
   */
  async commit(message: string): Promise<string | undefined> {
    await this.loadWorkspaceMeta();
    this.commitRev = undefined;
    const store = await this.storeSnapshot();
    const head = await this.headRev();
    const workspace = new Set(await listWorkspaceFiles(this.workspace));

    const changed = new Map<string, 'written' | 'deleted'>();
    const paths = new Set<string>([...store.thoughts.keys(), ...store.files.keys(), ...workspace, ...this.pending.keys()]);
    for (const rel of [...paths].sort()) {
      const kind = this.pending.get(rel);
      if (kind === 'written' || kind === 'deleted') {
        const doc = kind === 'written' ? (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel) : undefined;
        if (doc === (store.thoughts.get(rel) ?? store.files.get(rel))) continue;
        changed.set(rel, kind);
        continue;
      }
      const local = await this.localDoc(rel);
      const differs = local.read ? local.value !== (store.thoughts.get(rel) ?? store.files.get(rel)) : (store.revs.get(rel) ?? 0) > (this.stamps.get(rel)?.rev ?? 0);
      if (differs) changed.set(rel, workspace.has(rel) ? 'written' : 'deleted');
    }
    if (changed.size === 0) return undefined;

    // specs/16 psql row: every written thought carries the revision it was read
    // at; a mismatch aborts the transaction and names the paths.
    const stale: string[] = [];
    for (const [rel] of changed) {
      const recorded = this.base.get(rel);
      const storeRev = store.revs.get(rel) ?? 0;
      if (recorded !== undefined) {
        if (recorded !== storeRev) stale.push(rel);
      } else if (storeRev > this.lastRev) {
        stale.push(rel); // never read through this workspace
      }
    }
    if (stale.length > 0) {
      this.conflicted = stale;
      throw conflictError(stale, 'the store moved on underneath this workspace; re-run: thoughts sync');
    }

    const rev = head + 1;
    const author = this.opts.author ?? 'thoughts';
    const now = (this.opts.now ?? ((): Date => new Date()))();
    const client = await this.clientOrThrow();
    await client.query(tag('begin') + 'BEGIN');
    try {
      await client.query(tag('lock') + 'SELECT pg_advisory_xact_lock($1)', [advisoryKey(this.brainId)]);
      for (const [rel, kind] of changed) {
        if (kind === 'deleted') {
          if (store.thoughts.has(rel)) {
            await client.query(tag('delete_thought') + 'DELETE FROM thoughts WHERE path = $1', [rel]);
            await this.appendChange(client, rel, rev, 'removed', path.posix.basename(rel, '.md'), undefined, now, false);
          } else {
            await client.query(tag('delete_file') + 'DELETE FROM bundle_files WHERE path = $1', [rel]);
            await this.appendChange(client, rel, rev, 'removed', path.posix.basename(rel), undefined, now, false);
          }
          this.stamps.delete(rel);
          continue;
        }
        const doc = (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel) ?? '';
        const isThought = rel.endsWith('.md') && locate('/' + rel) !== undefined;
        if (isThought) {
          const row = docToRow(rel, doc, rev, author, this.brainId, now);
          await client.query(
            tag('upsert_thought') +
              `INSERT INTO thoughts (${THOUGHT_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ` +
              'ON CONFLICT (path) DO UPDATE SET id = EXCLUDED.id, repo_id = EXCLUDED.repo_id, kind = EXCLUDED.kind, zone = EXCLUDED.zone, ' +
              'title = EXCLUDED.title, status = EXCLUDED.status, created = EXCLUDED.created, updated = EXCLUDED.updated, supersedes = EXCLUDED.supersedes, ' +
              'superseded_by = EXCLUDED.superseded_by, stale_after = EXCLUDED.stale_after, frontmatter = EXCLUDED.frontmatter, body = EXCLUDED.body, ' +
              'document = EXCLUDED.document, revision = EXCLUDED.revision, author = EXCLUDED.author',
            [
              row.path, row.id, row.repo_id, row.kind, row.zone, row.title, row.status, row.created, row.updated, row.supersedes,
              row.superseded_by, row.stale_after, JSON.stringify(row.frontmatter), row.body, row.document, row.revision, row.author,
            ],
          );
          await this.appendChange(client, rel, rev, store.thoughts.has(rel) ? 'updated' : 'added', row.title ?? path.posix.basename(rel, '.md'), undefined, now, true);
        } else {
          await client.query(
            tag('upsert_file') +
              'INSERT INTO bundle_files (path, document, revision) VALUES ($1,$2,$3) ON CONFLICT (path) DO UPDATE SET document = EXCLUDED.document, revision = EXCLUDED.revision',
            [rel, doc, rev],
          );
          await this.appendChange(client, rel, rev, store.files.has(rel) ? 'updated' : 'added', path.posix.basename(rel), undefined, now, true);
        }
        await client.query(
          tag('history') + 'INSERT INTO history (path, revision, author, occurred_at, document) VALUES ($1,$2,$3,$4,$5)',
          [rel, rev, author, now.toISOString(), doc],
        );
        await this.stamp(rel, rev);
      }
      await client.query(tag('commit_row') + 'INSERT INTO commits (id, message, author, occurred_at) VALUES ($1,$2,$3,$4)', [
        rev, message, author, now.toISOString(),
      ]);
      await this.metaSet('rev', String(rev));
      await client.query(tag('prune_log') + PRUNE_CHANGE_LOG_SQL, [CHANGE_LOG_LIMIT]);
      await client.query(tag('commit_tx') + 'COMMIT');
    } catch (err) {
      try {
        await client.query(tag('rollback') + 'ROLLBACK');
      } catch {
        // the transaction was already gone
      }
      throw err;
    }

    this.lastRev = rev;
    this.commitRev = rev;
    await this.saveWorkspaceMeta();
    this.pending.clear();
    this.pendingDocs.clear();
    this.base.clear();
    this.conflicted = [];
    return String(rev);
  }

  /** One `change_log` row per changed path; `push` fills in the log entry. */
  private async appendChange(
    client: PgClientLike,
    rel: string,
    rev: number,
    change: 'added' | 'updated' | 'removed',
    title: string,
    entry: LogEntry | undefined,
    now: Date,
    upsert: boolean,
  ): Promise<void> {
    const suffix = upsert
      ? ' ON CONFLICT (path, revision) DO UPDATE SET change = EXCLUDED.change, title = COALESCE(EXCLUDED.title, change_log.title), ' +
        'by = COALESCE(EXCLUDED.by, change_log.by), note = COALESCE(EXCLUDED.note, change_log.note)'
      : '';
    await client.query(
      tag('log') +
        `INSERT INTO change_log (path, revision, change, title, by, note, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)${suffix}`,
      [rel, rev, change, entry?.title ?? title, entry?.by ?? null, entry?.note ?? null, now.toISOString()],
    );
  }

  /**
   * The transport step: the transaction already wrote the store (specs/16), so
   * the log entries attach to the revision this workspace committed — even if
   * a pull in between brought someone else's revision forward. Writing them at
   * that revision can never overwrite a foreign change_log row: (path,
   * revision) is this workspace's own pair.
   */
  async push(input: PushInput): Promise<PushResult> {
    const client = await this.clientOrThrow();
    const rev = this.commitRev ?? (this.lastRev > 0 ? this.lastRev : await this.headRev());
    const now = (this.opts.now ?? ((): Date => new Date()))();
    for (const entry of input.logEntries) {
      await this.appendChange(client, entry.path.replace(/^\/+/, ''), rev, entry.change, entry.title, entry, now, true);
    }
    return { pushed: true, revision: String(rev) };
  }

  /**
   * Pull (specs/16): rows with `revision >` the workspace's `last_rev`,
   * materialised into the workspace. A store change under a path this
   * workspace edited locally is the conflict of specs/16 — nothing is
   * overwritten, the paths are named, exit 4.
   */
  async pull(lastRev?: string, _ctx?: ConflictContext): Promise<StoreChange[]> {
    if (this.conflicted.length > 0) {
      throw conflictError(this.conflicted, 'the store moved on underneath this workspace; re-run: thoughts sync');
    }
    await this.loadWorkspaceMeta();
    const client = await this.clientOrThrow();
    const from = lastRev !== undefined ? Number(lastRev) : this.lastRev;
    const head = await this.headRev();
    if (!Number.isFinite(from) || from >= head) {
      this.lastRev = Math.max(this.lastRev, head);
      await this.saveWorkspaceMeta();
      return [];
    }

    const rows = await client.query(tag('since_rows') + `SELECT ${THOUGHT_COLUMNS} FROM thoughts WHERE revision > $1 ORDER BY revision, path`, [from]);
    const files = await client.query(tag('since_files') + 'SELECT path, document, revision FROM bundle_files WHERE revision > $1 ORDER BY revision, path', [from]);
    const log = await client.query(tag('since_changes') + 'SELECT path, change, revision FROM change_log WHERE revision > $1 ORDER BY revision, path', [from]);

    const incoming = new Map<string, { change: StoreChange['change']; rev: number }>();
    for (const row of log.rows) {
      const rel = String(row['path']);
      const rev = Number(row['revision']);
      const seen = incoming.get(rel);
      if (seen === undefined || rev >= seen.rev) incoming.set(rel, { change: row['change'] as StoreChange['change'], rev });
    }
    // A row the ledger does not mention (seeded directly) still arrives.
    for (const row of [...rows.rows, ...files.rows]) {
      const rel = String(row['path']);
      const rev = Number(row['revision']);
      if (!incoming.has(rel)) incoming.set(rel, { change: 'updated', rev });
    }

    // Conflict check before anything is written: a path this workspace edited
    // underneath a store change must not be overwritten (specs/16 psql row).
    const conflicted: string[] = [];
    for (const [rel] of incoming) {
      if (this.pending.has(rel)) {
        conflicted.push(rel);
        continue;
      }
      const doc = this.pullDoc(rows.rows, files.rows, rel);
      if (doc === undefined) continue;
      const local = await this.localDoc(rel);
      if (local.read && local.value !== undefined && local.value !== doc) conflicted.push(rel);
    }
    if (conflicted.length > 0) {
      this.conflicted = [...new Set(conflicted)].sort();
      throw conflictError(this.conflicted, 'the store moved on underneath this workspace; re-run: thoughts sync');
    }

    const changes: StoreChange[] = [];
    for (const [rel, change] of [...incoming.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const doc = this.pullDoc(rows.rows, files.rows, rel);
      if (doc === undefined) {
        this.stamps.delete(rel);
        await fs.promises.rm(path.join(this.workspace, rel), { force: true });
      } else {
        await writeWorkspaceFile(this.workspace, rel, doc);
        await this.stamp(rel, change.rev);
      }
      changes.push({ path: rel, change: change.change });
    }
    this.lastRev = head;
    await this.saveWorkspaceMeta();
    return changes;
  }

  /** The document an incoming path carries, thought row or bundle file. */
  private pullDoc(thoughtRows: Record<string, unknown>[], fileRows: Record<string, unknown>[], rel: string): string | undefined {
    const thought = thoughtRows.find((r) => String(r['path']) === rel);
    if (thought !== undefined) return String(thought['document']);
    const file = fileRows.find((r) => String(r['path']) === rel);
    return file === undefined ? undefined : String(file['document']);
  }

  async conflictInfo(): Promise<ConflictInfo> {
    return { conflicted: [...this.conflicted], inProgress: false };
  }

  /** specs/16: a base-revision mismatch is rolled back, never auto-settled. */
  async resolveConflicts(_ctx: ConflictContext): Promise<string[]> {
    return [...this.conflicted];
  }

  async revisionsSince(since: string): Promise<string[]> {
    const client = await this.clientOrThrow();
    const r = await client.query(tag('revs_since') + 'SELECT id FROM commits WHERE id > $1 ORDER BY id DESC', [Number(since)]);
    return r.rows.map((row) => String(row['id']));
  }

  /** From store metadata, never a walk (specs/16 Representation rule 3). */
  async behindCount(): Promise<number | undefined> {
    await this.loadWorkspaceMeta();
    try {
      return Math.max(0, (await this.headRev()) - this.lastRev);
    } catch {
      return undefined;
    }
  }

  /** The store's own `updated` column — never a file stat (specs/16). */
  async modifiedAt(relPath: string): Promise<Date | undefined> {
    const rel = relPath.replace(/^\/+/, '');
    await this.loadWorkspaceMeta();
    try {
      const row = await this.thoughtRow(rel);
      if (row !== undefined && row.updated !== null && row.updated !== undefined) return new Date(String(row.updated));
    } catch {
      return undefined;
    }
    return undefined;
  }

  async messageOf(revision: string): Promise<string> {
    const client = await this.clientOrThrow();
    const r = await client.query(tag('msg') + 'SELECT message FROM commits WHERE id = $1', [Number(revision)]);
    const message = r.rows[0]?.['message'];
    if (message === undefined || message === null) throw new ThoughtsError(`unknown revision: ${revision}`, ExitCode.Validation);
    return String(message);
  }

  /** specs/17 "Storage": the generated graph decomposed into node rows. */
  async saveGraph(repoId: string, doc: string): Promise<void> {
    const client = await this.clientOrThrow();
    const graph = parseGraphDoc(doc);
    const rev = await this.headRev();
    await client.query(tag('graph_clear_nodes') + 'DELETE FROM codegraph_nodes WHERE repo_id = $1', [repoId]);
    await client.query(tag('graph_clear_edges') + 'DELETE FROM codegraph_edges WHERE repo_id = $1', [repoId]);
    for (let i = 0; i < graph.nodes.length; i += 1) {
      const node = graph.nodes[i]!;
      await client.query(
        tag('graph_node') +
          'INSERT INTO codegraph_nodes (repo_id, id, kind, name, file, sha, ord, props) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ' +
          'ON CONFLICT (repo_id, id) DO UPDATE SET kind = EXCLUDED.kind, name = EXCLUDED.name, file = EXCLUDED.file, sha = EXCLUDED.sha, ' +
          'ord = EXCLUDED.ord, props = EXCLUDED.props',
        [repoId, str(node['id']) ?? '', str(node['kind']) ?? '', str(node['name']) ?? '', str(node['path']), str(node['sha']), i, JSON.stringify(node)],
      );
    }
    for (let i = 0; i < graph.edges.length; i += 1) {
      const edge = graph.edges[i]!;
      await client.query(
        tag('graph_edge') +
          'INSERT INTO codegraph_edges (repo_id, id, type, source, target, ord, props) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) ' +
          'ON CONFLICT (repo_id, id) DO UPDATE SET type = EXCLUDED.type, source = EXCLUDED.source, target = EXCLUDED.target, ' +
          'ord = EXCLUDED.ord, props = EXCLUDED.props',
        [repoId, str(edge['id']) ?? '', str(edge['type']) ?? '', str(edge['source']) ?? '', str(edge['target']) ?? '', i, JSON.stringify(edge)],
      );
    }
    await this.saveGraphMeta(repoId, doc, rev);
  }

  /**
   * specs/17 "Storage": the graph document of one repo. The byte-exact stored
   * document wins; the reassembly from `codegraph_nodes` / `codegraph_edges`
   * (in `ord` order) is the fallback that proves the tables carry the graph.
   */
  async loadGraph(repoId: string): Promise<string | undefined> {
    const client = await this.clientOrThrow();
    const meta = await client.query(tag('graph_meta_get') + 'SELECT document FROM codegraph_meta WHERE repo_id = $1', [repoId]);
    const metaDoc = meta.rows[0]?.['document'];
    if (typeof metaDoc === 'string' && metaDoc.length > 0) return metaDoc;
    const nodes = await client.query(tag('graph_nodes') + 'SELECT props FROM codegraph_nodes WHERE repo_id = $1 ORDER BY ord', [repoId]);
    const edges = await client.query(tag('graph_edges') + 'SELECT props FROM codegraph_edges WHERE repo_id = $1 ORDER BY ord', [repoId]);
    if (nodes.rows.length === 0 && edges.rows.length === 0) return undefined;
    return rebuildGraphDoc('{}', nodes.rows, edges.rows);
  }

  async saveGraphMeta(repoId: string, doc: string, rev?: number): Promise<void> {
    const client = await this.clientOrThrow();
    const atRev = rev ?? (await this.headRev());
    const commit = /codeCommit["']?\s*[:=]\s*"?([0-9a-f]+)/i.exec(doc)?.[1] ?? /codeCommit:\s*(\S+)/.exec(doc)?.[1] ?? null;
    await client.query(
      tag('graph_meta_set') +
        'INSERT INTO codegraph_meta (repo_id, code_commit, document, revision) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (repo_id) DO UPDATE SET code_commit = EXCLUDED.code_commit, document = EXCLUDED.document, revision = EXCLUDED.revision',
      [repoId, commit, doc, atRev],
    );
  }

  async loadGraphMeta(repoId: string): Promise<string | undefined> {
    const client = await this.clientOrThrow();
    const r = await client.query(tag('graph_meta_get') + 'SELECT document FROM codegraph_meta WHERE repo_id = $1', [repoId]);
    const doc = r.rows[0]?.['document'];
    return doc === undefined || doc === null ? undefined : String(doc);
  }

  // -- psql-specific serving (specs/16 Representation rule 3) ---------------

  /**
   * A native-index query: column filters and Postgres FTS over title + body,
   * returning only matched rows — the shape `search` (specs/05) serves from.
   */
  async searchThoughts(q: ThoughtQuery = {}): Promise<{ path: string; document: string; revision: number }[]> {
    const client = await this.clientOrThrow();
    const { sql, params } = buildThoughtQuery(q);
    const r = await client.query(sql, params);
    return r.rows.map((row) => ({ path: String(row['path']), document: String(row['document']), revision: Number(row['revision']) }));
  }

  /**
   * Materialise the workspace from the store (specs/16 "Provisioning" step 1,
   * init): every thought and bundle file the workspace has not applied yet.
   */
  async materialise(): Promise<StoreChange[]> {
    await this.loadWorkspaceMeta();
    return this.pull(undefined);
  }
}

/** Advisory lock key (specs/16): derived from the brain id, one per brain. */
export function advisoryKey(brainId: string): number {
  return Number.parseInt(createHash('sha256').update(`thoughts:${brainId}`, 'utf8').digest('hex').slice(0, 14), 16);
}

/** Split a DDL file into statements (balanced parens, single quotes, `--` comments). */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inSingle && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === "'") inSingle = !inSingle;
    if (!inSingle) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      else if (ch === ';' && depth === 0) {
        const statement = current.trim();
        if (statement.length > 0) statements.push(statement + ';');
        current = '';
        continue;
      }
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/** The shipped DDL (specs/16 "Provisioning"): from `dist/` or from `src/`. */
export function loadPgSchema(): string {
  for (const rel of ['src/brain/backends/schema/pg.sql', 'dist/brain/backends/schema/pg.sql']) {
    const p = assetPath(...rel.split('/'));
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      // try the next location
    }
  }
  throw new ThoughtsError('the psql schema file (schema/pg.sql) is missing from this installation', ExitCode.Validation, {
    hint: 'reinstall the thoughts CLI',
  });
}

/** Parse a graph document loosely: a broken graph stores as an empty one. */
function parseGraphDoc(doc: string): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  try {
    const parsed = JSON.parse(doc) as Record<string, unknown>;
    const items = (key: string): Record<string, unknown>[] =>
      Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).map((v) => (isRecord(v) ? v : {})) : [];
    return { nodes: items('nodes'), edges: items('edges') };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Reassemble the graph document from `codegraph_nodes` / `codegraph_edges`. */
function rebuildGraphDoc(metaDoc: string, nodeRows: Record<string, unknown>[], edgeRows: Record<string, unknown>[]): string {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(metaDoc);
    if (isRecord(parsed)) meta = parsed;
  } catch {
    meta = {};
  }
  return JSON.stringify({ ...meta, nodes: nodeRows.map((r) => r['props']), edges: edgeRows.map((r) => r['props']) }, null, 2) + '\n';
}

/** Workspace files the backend compares against the store (names only). */
async function listWorkspaceFiles(workspace: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (rel === '.git' || rel.startsWith('.git/') || rel === META_FILE) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else if (e.isFile()) found.push(rel);
    }
  };
  await walk(workspace, '');
  return found.sort();
}
