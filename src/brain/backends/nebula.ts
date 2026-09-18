/**
 * The nebula backend (specs/16): a NebulaGraph space is the store of record,
 * batched nGQL statements are the transport, and `~/.thoughts/brains/<id>/` is
 * the materialised OKF view the CLI writes back to.
 *
 * Representation (specs/16 "Representation", D22): the OKF document is the
 * canonical unit, and the store represents it natively — frontmatter fields as
 * `thought` VERTEX PROPERTIES, relations between thoughts as edges (`LINKS_TO`
 * from `sources[]` and from markdown links that resolve to another thought;
 * `SUPERSEDES` from frontmatter `supersedes`). Links buried in body text are
 * non-conforming as a *representation*: they are lifted into edges here. The
 * `document` property is not that dump: it is the byte-exact copy of the
 * canonical OKF document so the workspace materialises back without
 * reformatting anyone's frontmatter; every query path reads the properties and
 * traverses the edges, and the full frontmatter travels as a JSON object
 * literal in the `frontmatter` property (the nebula analogue of psql's jsonb).
 *
 * Serving (specs/16 Representation rule 3): every queryable question runs as a
 * `LOOKUP` / `GO FROM … OVER` traversal against the tag/edge indexes of
 * schema/nebula.ngql — never a walk of the workspace markdown.
 *
 * Conflict semantics (specs/16 sync table, nebula row): NebulaGraph has no
 * transaction and no optimistic check, so the rule is **store wins** — a base
 * revision the store has moved past is refused before anything is written, the
 * local change is overwritten by the store's version, `sync` warns and the
 * loss is recorded in `log.md` and in the store's change log. Never silent.
 *
 * Pull semantics (specs/16): the space's thought vertices are re-read by
 * revision; the bounded change log carries what changed per revision and is
 * the source of `log.md` regeneration and of `scan --history`, which MUST say
 * the history is partial rather than pretend.
 *
 * The transport is the thin client of nebula-client.ts; tests drive this class
 * through the `client` / `connect` seams — no server, and no behaviour
 * difference.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { locate } from '../location.js';
import { parseFrontmatter } from '../okf.js';
import { regenerate } from '../generate.js';
import { NebulaHttpClient, nqLit, schemaStatements, tagged, type NebulaClientLike } from './nebula-client.js';
import { nqId as ngqlNqId } from './nebula-ngql.js';
import { listWorkspaceThoughts, readWorkspaceFile, writeWorkspaceFile } from './workspace.js';
import { DEFAULT_NEBULA_CONNECTION_ENV, maskConnectionString, resolveCredRef } from './credref.js';
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

/** Version the shipped DDL records in the provision report (specs/16). */
export const NEBULA_SCHEMA_VERSION = '0001';

/** Thought vertices per INSERT VERTEX statement (specs/16: batched nGQL writes). */
export const NEBULA_ROWS_PER_STATEMENT = 50;

/** The change log is bounded (specs/16): the newest rows are kept, older ones pruned at commit. */
export const CHANGE_LOG_LIMIT = 10_000;

/** The space name a brain gets when `brain.yml` does not name one. */
export function defaultSpaceName(brainId: string): string {
  return brainId.replace(/[^A-Za-z0-9_]/g, '_');
}

// ---------------------------------------------------------------------------
// Native representation (specs/16 Representation, D22)
// ---------------------------------------------------------------------------

/** Vertex properties of `thought` — the filterable frontmatter fields (D22). */
export const THOUGHT_COLUMNS = [
  'path', 'id', 'repo_id', 'kind', 'zone', 'title', 'status', 'created', 'updated', 'supersedes', 'superseded_by',
  'stale_after', 'frontmatter', 'body', 'document', 'revision', 'author',
] as const;

/** Vertex properties of `bundle_file` (workspace files that are not concepts). */
export const BUNDLE_COLUMNS = ['path', 'document', 'revision'] as const;

/** Vertex properties of `change_log` — the bounded change log (specs/16). */
export const CHANGE_COLUMNS = ['path', 'revision', 'change', 'title', 'by', 'note', 'occurred_at', 'document'] as const;

/** Vertex properties of `brain_commit`. */
export const COMMIT_COLUMNS = ['id', 'message', 'author', 'occurred_at'] as const;

/** Vertex properties of the codegraph tags (specs/17 "Storage", D23). */
export const GRAPH_TAG_COLUMNS: Record<string, readonly string[]> = {
  code_file: ['repo_id', 'name', 'path', 'sha', 'language', 'code_commit', 'ord'],
  code_symbol: ['repo_id', 'name', 'path', 'symbol_kind', 'line', 'end_line', 'sha', 'code_commit', 'ord'],
  code_module: ['repo_id', 'name', 'manifest', 'code_commit', 'ord'],
};

/** Edge types and their properties (specs/17 "Storage", D23). */
export const GRAPH_EDGE_COLUMNS: Record<string, readonly string[]> = {
  CONTAINS: ['repo_id', 'code_commit'],
  IMPORTS: ['repo_id', 'code_commit'],
  CALLS: ['repo_id', 'code_commit'],
  IMPORTS_REPO: ['repo_id', 'code_commit'],
};

export const GRAPH_TAG_OF_NODE_KIND: Record<string, string> = { file: 'code_file', symbol: 'code_symbol', module: 'code_module' };
export const GRAPH_NODE_KIND_OF_TAG: Record<string, string> = { code_file: 'file', code_symbol: 'symbol', code_module: 'module' };
export const GRAPH_EDGE_OF_TYPE: Record<string, string> = {
  contains: 'CONTAINS',
  imports: 'IMPORTS',
  calls: 'CALLS',
  imports_repo: 'IMPORTS_REPO',
};

/** One row of a vertex insert: the vertex id plus one value per column. */
export interface VertexRow {
  vid: string;
  values: unknown[];
}

/** One row of an edge insert: endpoints plus one value per column. */
export interface EdgeRow {
  src: string;
  dst: string;
  values: unknown[];
}

/** The `thought` vertex of one OKF document (specs/16 Representation rule 2). */
export interface ThoughtVertex extends VertexRow {
  path: string;
  id: string;
  repo_id: string | null;
  kind: string | null;
  zone: string | null;
  title: string | null;
  status: string | null;
  created: string;
  updated: string;
  supersedes: string | null;
  superseded_by: string | null;
  stale_after: string | null;
  frontmatter: string;
  body: string;
  document: string;
  revision: number;
  author: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Stable vertex id of a thought: hash of brain id + path (specs/17 style). */
export function thoughtVid(brainId: string, relPath: string): string {
  return sha256(`${brainId}\n${relPath}`);
}

/** Vertex id of a workspace file that is not a concept. */
export function bundleVid(brainId: string, relPath: string): string {
  return sha256(`${brainId}\nfile:${relPath}`);
}

/** Vertex id of one change-log row. */
export function changeVid(brainId: string, relPath: string, revision: number): string {
  return sha256(`${brainId}\nchange:${relPath}\n${revision}`);
}

/** Vertex id of a store revision's commit row. */
export function commitVid(brainId: string, revision: number): string {
  return sha256(`${brainId}\ncommit:${revision}`);
}

/** Vertex id of the space's single metadata vertex. */
export function metaVid(brainId: string): string {
  return sha256(`${brainId}\nmeta`);
}

/** Vertex id of a repo's codegraph metadata vertex. */
export function graphMetaVid(brainId: string, repoId: string): string {
  return sha256(`${brainId}\ncodegraph:${repoId}`);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Split one OKF document into its native vertex (frontmatter fields as properties). */
export function docToVertex(relPath: string, doc: string, revision: number, author: string | undefined, brainId: string, now: Date): ThoughtVertex {
  const parsed = parseFrontmatter(doc);
  const fm: Record<string, unknown> = isRecord(parsed.frontmatter) ? parsed.frontmatter : {};
  const loc = locate('/' + relPath.replace(/^\/+/, ''));
  const generated = isRecord(fm['generated']) ? (fm['generated'] as Record<string, unknown>) : {};
  const created = str(generated['at']) ?? now.toISOString();
  const vertex: ThoughtVertex = {
    vid: thoughtVid(brainId, relPath),
    path: relPath,
    id: thoughtVid(brainId, relPath),
    repo_id: str(fm['repo']) ?? loc?.owner ?? null,
    kind: loc?.kind ?? null,
    zone: loc?.zone ?? null,
    title: str(fm['title']),
    status: str(fm['status']),
    created,
    updated: now.toISOString(),
    supersedes: str(fm['supersedes']),
    superseded_by: str(fm['superseded_by']),
    stale_after: str(fm['stale_after']),
    frontmatter: JSON.stringify(fm),
    body: parsed.body,
    document: doc,
    revision,
    author: author ?? null,
    values: [],
  };
  vertex.values = THOUGHT_COLUMNS.map((column) => (vertex as unknown as Record<string, unknown>)[column] ?? null);
  return vertex;
}

/**
 * Rebuild the OKF document from the native properties (frontmatter + body).
 * The byte-exact `document` property wins when present; this is the fallback
 * that proves the properties carry the whole document.
 */
export function vertexToDoc(vertex: Record<string, unknown>): string | undefined {
  const document = vertex['document'];
  if (typeof document === 'string' && document.length > 0) return document;
  let fm: unknown;
  try {
    fm = JSON.parse(String(vertex['frontmatter'] ?? '{}'));
  } catch {
    fm = {};
  }
  const lines = isRecord(fm) ? Object.entries(fm).map(([key, value]) => `${key}: ${JSON.stringify(value)}`) : [];
  return `---\n${lines.join('\n')}\n---\n${vertex['body'] ?? ''}`;
}

// ---------------------------------------------------------------------------
// Relation edges (specs/16 Representation rule 2, D22)
// ---------------------------------------------------------------------------

/** Bundle-relative thought paths a document relates to, extracted natively (the source of the LINKS_TO / SUPERSEDES edges). */
export function extractThoughtRelations(relPath: string, doc: string): { supersedes: string[]; linksTo: string[] } {
  const parsed = parseFrontmatter(doc);
  const fm: Record<string, unknown> = isRecord(parsed.frontmatter) ? parsed.frontmatter : {};
  const self = relPath.replace(/^\/+/, '');
  const supersedes = new Set<string>();
  const linksTo = new Set<string>();
  // A relation is one the document declares: frontmatter `supersedes` /
  // `superseded_by`, a `sources[]` entry, or a markdown link that resolves to
  // another thought of this brain. Only the last means the relation lives in
  // body text — and here it is lifted out of it into an edge (D22).
  const targetOf = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const target = value.trim().replace(/^\/+/, '');
    if (target.length === 0 || target === self) return undefined;
    if (!target.endsWith('.md') || locate('/' + target) === undefined) return undefined;
    return target;
  };
  const superseded = targetOf(fm['supersedes']);
  if (superseded !== undefined) supersedes.add(superseded);
  const supersededBy = targetOf(fm['superseded_by']);
  if (supersededBy !== undefined) supersedes.add(supersededBy);
  const sources = Array.isArray(fm['sources']) ? fm['sources'] : [];
  for (const source of sources) {
    const target = isRecord(source) ? targetOf(source['resource']) : undefined;
    if (target !== undefined) linksTo.add(target);
  }
  for (const m of parsed.body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = targetOf(m[1]);
    if (target !== undefined) linksTo.add(target);
  }
  return { supersedes: [...supersedes], linksTo: [...linksTo] };
}

// ---------------------------------------------------------------------------
// nGQL construction (exported for the query-construction tests)
// ---------------------------------------------------------------------------

/** Quote an identifier (space / tag / edge / property name) for nGQL. */
export const nqId = ngqlNqId;

/** Multi-row INSERT VERTEX — one round-trip per batch (specs/16 "Batched nGQL writes"). */
export function ngqlUpsertVertices(op: string, tag: string, columns: readonly string[], rows: VertexRow[]): string {
  if (rows.length === 0) return '';
  const values = rows.map((r) => `${nqLit(r.vid)}:(${r.values.map(nqLit).join(', ')})`).join(', ');
  return tagged(op, `INSERT VERTEX ${nqId(tag)}(${columns.map(nqId).join(', ')}) VALUES ${values}`);
}

/** Multi-row INSERT EDGE. */
export function ngqlUpsertEdges(op: string, edge: string, columns: readonly string[], rows: EdgeRow[]): string {
  if (rows.length === 0) return '';
  const values = rows.map((r) => `${nqLit(r.src)}->${nqLit(r.dst)}:(${r.values.map(nqLit).join(', ')})`).join(', ');
  return tagged(op, `INSERT EDGE ${nqId(edge)}(${columns.map(nqId).join(', ')}) VALUES ${values}`);
}

/** Multi-row DELETE VERTEX (WITH EDGE removes the edges that touch them). */
export function ngqlDeleteVertices(op: string, vids: string[]): string {
  if (vids.length === 0) return '';
  return tagged(op, `DELETE VERTEX ${vids.map(nqLit).join(', ')} WITH EDGE`);
}

/** A `thought` query: LOOKUP over the tag indexes, then pipe filters — never a walk. */
export interface ThoughtQuery {
  /** Full text over title + body (pipe `CONTAINS` filters after the indexed LOOKUP). */
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
 * Build the nGQL a native-index query runs: `LOOKUP ON thought` with the
 * indexed equalities in WHERE, the text terms as pipe `CONTAINS` filters, then
 * ORDER BY / LIMIT. Exported for the query-construction tests; `searchThoughts`
 * is the only runtime caller.
 */
export function buildThoughtQuery(q: ThoughtQuery): { stmt: string; params: Record<string, unknown> } {
  const params: Record<string, unknown> = {};
  const where: string[] = [];
  const pipe: string[] = [];
  if (q.repoId !== undefined) {
    params['repo_id'] = q.repoId;
    where.push('thought.repo_id == $repo_id');
  }
  if (q.zone !== undefined) {
    params['zone'] = q.zone;
    where.push('thought.zone == $zone');
  }
  if (q.kind !== undefined) {
    params['kind'] = q.kind;
    where.push('thought.kind == $kind');
  }
  if (q.status !== undefined) {
    params['status'] = q.status;
    where.push('thought.status == $status');
  }
  if (q.sinceRevision !== undefined) {
    params['since'] = Number(q.sinceRevision);
    where.push('thought.revision > $since');
  }
  const terms = (q.text ?? '').trim().split(/\s+/).filter((t) => t.length > 0);
  terms.forEach((term, i) => {
    params[`term${i}`] = term;
    pipe.push(`($-.title CONTAINS $term${i} OR $-.body CONTAINS $term${i})`);
  });
  if (q.limit !== undefined && q.limit > 0) params['limit'] = Math.floor(q.limit);
  const stmt =
    tagged('search', 'LOOKUP ON thought' + (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') + ' YIELD id(vertex) AS vid, ' +
      'properties(vertex).path AS path, properties(vertex).document AS document, properties(vertex).revision AS revision, ' +
      'properties(vertex).title AS title, properties(vertex).body AS body') +
    (pipe.length > 0 ? ` | WHERE ${pipe.join(' AND ')}` : '') +
    ' | ORDER BY $-.revision DESC, $-.path ASC' +
    (params['limit'] !== undefined ? ' | LIMIT $limit' : '');
  return { stmt, params };
}

/** `GO FROM … OVER LINKS_TO, SUPERSEDES` — a thought's relations (specs/16 rule 3). */
export function buildRelationsQuery(vid: string): { stmt: string; params: Record<string, unknown> } {
  return {
    stmt: tagged('relations', 'GO FROM $vid OVER LINKS_TO, SUPERSEDES YIELD type(edge) AS type, dst(edge) AS dst, properties($$).path AS path'),
    params: { vid },
  };
}

/**
 * Cross-repo codegraph traversal (specs/17 "Cross-repo edges"): the sibling
 * modules whose `IMPORTS_REPO` edges point at this repo's modules — a reverse
 * `GO FROM … OVER IMPORTS_REPO` over the stored graphs, never a workspace walk.
 */
export function buildImportsRepoQuery(moduleVids: string[]): { stmt: string; params: Record<string, unknown> } {
  return {
    stmt: tagged(
      'imports_repo',
      `GO FROM ${moduleVids.map(nqLit).join(', ')} OVER IMPORTS_REPO REVERSELY YIELD properties($^).repo_id AS from_repo, ` +
        'properties($^).name AS module, dst(edge) AS dst',
    ),
    params: {},
  };
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

interface LocalDoc {
  /** True when the file content itself was read (or the file is gone). */
  read: boolean;
  value: string | undefined;
}

interface StoreSnapshot {
  thoughts: Map<string, { document: string; revision: number }>;
  files: Map<string, { document: string; revision: number }>;
}

export interface NebulaBackendOptions {
  brainId: string;
  workspace: string;
  /** Cred-ref (specs/10): `env:VAR` or `keyref:name`. Never a connection string. */
  connectionRef?: string;
  /** nebula only: the space name (specs/16 brain.yml backend block). */
  space?: string;
  /** Test seam: an already-connected client. */
  client?: NebulaClientLike;
  /** Test seam: connect with the resolved connection string. */
  connect?: (connectionString: string) => Promise<NebulaClientLike>;
  /**
   * Test seam: how long provisioning waits between CREATE TAG/EDGE retries
   * while a fresh space settles (default 1s).
   */
  retryDelayMs?: number;
  now?: () => Date;
  author?: string;
}

export class NebulaBackend implements BrainBackend {
  readonly kind = 'nebula' as const;
  readonly brainId: string;
  readonly workspace: string;
  readonly connectionRef: string | undefined;
  /** specs/16 sync table: a bounded change log, not a full history. */
  readonly historyMode = 'partial' as const;

  private readonly opts: NebulaBackendOptions;
  readonly space: string;
  private client: NebulaClientLike | undefined;
  private connecting: Promise<NebulaClientLike> | undefined;
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
  /** Paths the store won underneath this workspace (specs/16 nebula row). */
  private conflicted: string[] = [];

  constructor(opts: NebulaBackendOptions) {
    this.opts = opts;
    this.brainId = opts.brainId;
    this.workspace = opts.workspace;
    this.connectionRef = opts.connectionRef;
    this.space = opts.space !== undefined && opts.space.length > 0 ? opts.space : defaultSpaceName(opts.brainId);
  }

  // -- connection ----------------------------------------------------------

  private async clientOrThrow(): Promise<NebulaClientLike> {
    if (this.client) return this.client;
    if (!this.connecting) this.connecting = this.connect();
    try {
      this.client = await this.connecting;
    } finally {
      this.connecting = undefined;
    }
    return this.client;
  }

  private async connect(): Promise<NebulaClientLike> {
    if (this.opts.client) return this.opts.client;
    const connectionString = await this.connectionString();
    try {
      if (this.opts.connect) return await this.opts.connect(connectionString);
      return new NebulaHttpClient(connectionString);
    } catch (err) {
      if (err instanceof ThoughtsError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if ((err as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(message)) {
        throw new ThoughtsError('the Nebula transport is not available', ExitCode.Validation, {
          hint: 'the client is built in; check the thoughts installation',
          cause: err,
        });
      }
      // Never echo a connection string (specs/16): diagnostics are masked.
      throw new ThoughtsError(`nebula brain "${this.brainId}" is unreachable: ${maskConnectionString(message)}`, ExitCode.RemoteUnreachable, {
        hint: 'check the connection reference and that the gateway is running, then re-run',
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
      throw new ThoughtsError(`nebula brain "${this.brainId}" has no connection reference`, ExitCode.Validation, {
        hint: `pass --connection-ref env:${DEFAULT_NEBULA_CONNECTION_ENV} and set that environment variable to the connection string`,
      });
    }
    return resolveCredRef(ref);
  }

  /** The non-secret object name this store lives in (specs/16 brain.yml block). */
  async storeName(): Promise<string> {
    return this.space;
  }

  /**
   * Apply `schema/nebula.ngql` with this brain's space (specs/16
   * "Provisioning"). A space created moments ago needs ~2 heartbeats before
   * its first CREATE TAG succeeds, so those statements get a short bounded
   * retry; the index rebuilds that follow are best effort — a failed rebuild
   * costs index-backed performance, never provisioning.
   */
  async provision(): Promise<{ applied: boolean; version: string }> {
    const client = await this.clientOrThrow();
    const statements = schemaStatements(this.space);
    for (const stmt of statements) {
      if (/^CREATE (TAG|EDGE) /i.test(stmt)) await retryWhileSpaceSettles(() => client.execute(stmt), this.opts.retryDelayMs);
      else await client.execute(stmt);
    }
    await this.rebuildIndexes(client);
    // Seed the revision counter at 1 — the analogue of the git brain's root
    // commit and of pg.sql's `INSERT INTO meta ... 'rev', '1'`.
    if ((await this.headRev()) === 0) await this.setHeadRev(1, 'seed');
    return { applied: true, version: NEBULA_SCHEMA_VERSION };
  }

  /**
   * `REBUILD TAG INDEX` / `REBUILD EDGE INDEX` for every index the shipped DDL
   * declares (specs/16 Representation rule 3: serving traverses these indexes,
   * and `LOOKUP` returns nothing until they are built). Best effort, one
   * statement each: any failure is tolerated and the next `init` re-runs it.
   */
  private async rebuildIndexes(client: NebulaClientLike): Promise<void> {
    for (const stmt of rebuildStatements(schemaStatements(this.space))) {
      try {
        await client.execute(stmt);
      } catch {
        // fail soft: the index exists; only its data is not rebuilt yet
      }
    }
  }

  // -- workspace state -----------------------------------------------------

  /** Load `meta.yml` (last_rev + materialisation stamps). One small read. */
  private async loadWorkspaceMeta(): Promise<void> {
    if (this.metaLoaded) return;
    this.metaLoaded = true;
    const text = await readWorkspaceFile(this.workspace, META_FILE);
    if (text === undefined) return;
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
    await writeWorkspaceFile(
      this.workspace,
      META_FILE,
      YAML.stringify({ backend: 'nebula', space: this.space, last_rev: this.lastRev, files }, { lineWidth: 0 }),
    );
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

  private async execute(op: string, body: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    return this.query(tagged(op, body), params);
  }

  /** One traversal/statement against the space (specs/16 Representation rule 3). */
  private async query(stmt: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const client = await this.clientOrThrow();
    const result = await client.execute(stmt, params);
    return result.rows;
  }

  private async headRev(): Promise<number> {
    const rows = await this.execute(
      'head',
      'LOOKUP ON brain_meta WHERE brain_meta.brain_id == $brain_id YIELD properties(vertex).rev AS rev',
      { brain_id: this.brainId },
    );
    const n = Number(rows[0]?.['rev']);
    return Number.isFinite(n) ? n : 0;
  }

  private async setHeadRev(rev: number, message: string | undefined): Promise<void> {
    if (message !== undefined) {
      const now = (this.opts.now ?? ((): Date => new Date()))();
      await this.execute(
        'commit_upsert',
        'INSERT VERTEX brain_commit(id, message, author, occurred_at) VALUES ' +
          `${nqLit(commitVid(this.brainId, rev))}:(${nqLit(rev)}, ${nqLit(message)}, ${nqLit(this.opts.author ?? 'thoughts')}, ${nqLit(now.toISOString())})`,
      );
    }
    await this.execute(
      'meta_set',
      'UPSERT VERTEX ON brain_meta ' + nqLit(metaVid(this.brainId)) + ' SET brain_id = $brain_id, rev = $rev',
      { brain_id: this.brainId, rev },
    );
  }

  private async storeSnapshot(): Promise<StoreSnapshot> {
    const client = await this.clientOrThrow();
    const snapshot: StoreSnapshot = { thoughts: new Map(), files: new Map() };
    const thoughts = await client.execute(
      tagged('rows_all', 'LOOKUP ON thought YIELD properties(vertex).path AS path, properties(vertex).document AS document, properties(vertex).revision AS revision'),
    );
    for (const row of thoughts.rows) snapshot.thoughts.set(String(row['path']), { document: String(row['document'] ?? ''), revision: Number(row['revision'] ?? 0) });
    const files = await client.execute(
      tagged('files_all', 'LOOKUP ON bundle_file YIELD properties(vertex).path AS path, properties(vertex).document AS document, properties(vertex).revision AS revision'),
    );
    for (const row of files.rows) snapshot.files.set(String(row['path']), { document: String(row['document'] ?? ''), revision: Number(row['revision'] ?? 0) });
    return snapshot;
  }

  private async thoughtVertex(relPath: string): Promise<Record<string, unknown> | undefined> {
    const rows = await this.execute(
      'fetch_thought',
      'FETCH PROP ON thought ' + nqLit(thoughtVid(this.brainId, relPath)) + ' YIELD properties(vertex) AS props',
    );
    const props = rows[0]?.['props'];
    return isRecord(props) ? props : undefined;
  }

  /** Store revision of one path, 0 when the store has none. */
  private async storeRevOf(rel: string): Promise<number> {
    try {
      const vertex = await this.thoughtVertex(rel);
      const n = Number(vertex?.['revision']);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0; // unreachable: the base-revision check at commit decides
    }
  }

  /** Materialise the workspace when the store is ahead of it (specs/16 "Workspace vs store"). */
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
      // A store change under an uncommitted local edit is the store-wins
      // conflict of specs/16 — but materialising is a read-side step (status,
      // dirty): it must not overwrite the workspace mid-read. Leave the local
      // edit in place; the conflict surfaces at commit, where the settlement
      // (store wins + log.md note) runs.
      if (err instanceof ThoughtsError && err.exitCode === ExitCode.Conflict) return;
      throw err;
    }
  }

  // -- BrainBackend --------------------------------------------------------

  async health(): Promise<BackendHealth> {
    try {
      const client = await this.clientOrThrow();
      await client.execute(tagged('ping', 'YIELD 1 AS ok'));
      return { ok: true, detail: `nebula space ${this.space}` };
    } catch (err) {
      const detail = err instanceof ThoughtsError ? err.message : maskConnectionString(err instanceof Error ? err.message : String(err));
      return { ok: false, detail };
    }
  }

  /** Thought paths: store vertices first, then this run's writes, then the workspace. */
  async listThoughts(): Promise<string[]> {
    const paths = new Set<string>();
    try {
      const client = await this.clientOrThrow();
      const r = await client.execute(tagged('paths', 'LOOKUP ON thought YIELD properties(vertex).path AS path'));
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
      // specs/16: a nebula brain's history is the bounded change log; a
      // revision pruned out of it returns undefined rather than a guess.
      const head = opts.revision === 'HEAD' ? await this.headRev() : Number(opts.revision);
      const rows = await this.execute(
        'change_at',
        'LOOKUP ON change_log WHERE change_log.path == $path AND change_log.revision <= $revision YIELD properties(vertex).document AS document, ' +
          'properties(vertex).revision AS revision | ORDER BY $-.revision DESC | LIMIT 1',
        { path: rel, revision: head },
      );
      const doc = rows[0]?.['document'];
      return doc === undefined || doc === null ? undefined : String(doc);
    }
    const pending = this.pending.get(rel);
    if (pending === 'written') return (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel);
    if (pending === 'deleted') return undefined;
    try {
      const vertex = await this.thoughtVertex(rel);
      const doc = vertexToDoc(vertex ?? {});
      if (doc !== undefined) return doc;
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
   * a clean workspace costs zero thought reads (specs/16 acceptance).
   */
  async dirty(): Promise<WorkspaceChange[]> {
    await this.ensureMaterialised();
    let store: StoreSnapshot;
    try {
      store = await this.storeSnapshot();
    } catch {
      return []; // unreachable: nothing to compare against; local work is kept
    }
    const workspace = new Set(await listWorkspaceThoughts(this.workspace));
    const paths = new Set<string>([...store.thoughts.keys(), ...store.files.keys(), ...workspace, ...this.pending.keys()]);
    const changes: WorkspaceChange[] = [];
    for (const rel of [...paths].sort()) {
      const kind = this.pending.get(rel);
      const remote = store.thoughts.get(rel) ?? store.files.get(rel);
      const remoteRev = remote?.revision ?? 0;
      if (kind !== undefined) {
        const doc = kind === 'written' ? (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel) : undefined;
        if (doc === remote?.document) continue;
        changes.push({ path: rel, code: doc === undefined ? 'D' : remote === undefined ? 'A' : 'M', deleted: doc === undefined });
        continue;
      }
      const local = await this.localDoc(rel);
      const differs = local.read ? local.value !== remote?.document : remoteRev > (this.stamps.get(rel)?.rev ?? 0);
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
    return `nebula:${this.brainId}`;
  }

  /** Workspace-vs-store diff between two store revisions, newest last. */
  async diff(from: string, to?: string): Promise<WorkspaceChange[]> {
    const a = Number(from);
    const b = to === undefined || to === 'HEAD' ? await this.headRev() : Number(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    const rows = await this.execute(
      'changes_between',
      'LOOKUP ON change_log WHERE change_log.revision > $from AND change_log.revision <= $to YIELD properties(vertex).path AS path, ' +
        'properties(vertex).change AS change, properties(vertex).revision AS revision | ORDER BY $-.revision ASC, $-.path ASC',
      { from: a, to: b },
    );
    const byPath = new Map<string, WorkspaceChange>();
    for (const row of rows) {
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
   * Settle the workspace into the store with batched nGQL writes (specs/16
   * nebula row). Paths the store has moved past since this workspace read them
   * are refused before anything is written — the store keeps its side, and the
   * settlement is the store-wins one of `resolveConflicts`.
   */
  async commit(message: string): Promise<string | undefined> {
    await this.loadWorkspaceMeta();
    this.commitRev = undefined;
    const store = await this.storeSnapshot();
    const head = await this.headRev();
    const workspace = new Set(await listWorkspaceThoughts(this.workspace));

    const changed = new Map<string, 'written' | 'deleted'>();
    const paths = new Set<string>([...store.thoughts.keys(), ...store.files.keys(), ...workspace, ...this.pending.keys()]);
    for (const rel of [...paths].sort()) {
      const kind = this.pending.get(rel);
      if (kind === 'written' || kind === 'deleted') {
        const doc = kind === 'written' ? (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel) : undefined;
        if (doc === remoteDocOf(store, rel)) continue;
        changed.set(rel, kind);
        continue;
      }
      const local = await this.localDoc(rel);
      const remote = remoteDocOf(store, rel);
      const differs = local.read ? local.value !== remote : (store.thoughts.get(rel)?.revision ?? 0) > (this.stamps.get(rel)?.rev ?? 0);
      if (differs) changed.set(rel, workspace.has(rel) ? 'written' : 'deleted');
    }
    if (changed.size === 0) return undefined;

    // specs/16 nebula row: no optimistic check is available, so a base
    // revision the store has moved past is a store-wins conflict — nothing is
    // written, the store keeps its version, and the loss is recorded (never
    // silently) when the workspace is settled.
    const stale: string[] = [];
    for (const [rel] of changed) {
      const recorded = this.base.get(rel);
      const storeRev = store.thoughts.get(rel)?.revision ?? 0;
      if (recorded !== undefined) {
        if (recorded !== storeRev) stale.push(rel);
      } else if (storeRev > this.lastRev) {
        stale.push(rel); // never read through this workspace
      }
    }
    if (stale.length > 0) {
      this.conflicted = stale;
      throw conflictError(stale, 'the store moved on underneath this workspace and keeps its version (store wins, specs/16); re-run: thoughts sync');
    }

    const rev = head + 1;
    const author = this.opts.author ?? 'thoughts';
    const now = (this.opts.now ?? ((): Date => new Date()))();

    const deletes: string[] = [];
    const thoughtRows: VertexRow[] = [];
    const bundleRows: VertexRow[] = [];
    const changeRows: VertexRow[] = [];
    const supersedeEdges: EdgeRow[] = [];
    const linkEdges: EdgeRow[] = [];
    for (const [rel, kind] of changed) {
      if (kind === 'deleted') {
        const vid = store.thoughts.has(rel) ? thoughtVid(this.brainId, rel) : bundleVid(this.brainId, rel);
        deletes.push(vid);
        changeRows.push(changeRow(this.brainId, rel, rev, 'removed', path.posix.basename(rel, '.md'), undefined, undefined, now, undefined));
        this.stamps.delete(rel);
        continue;
      }
      const doc = (await readWorkspaceFile(this.workspace, rel)) ?? this.pendingDocs.get(rel) ?? '';
      const isThought = rel.endsWith('.md') && locate('/' + rel) !== undefined;
      if (isThought) {
        const vertex = docToVertex(rel, doc, rev, author, this.brainId, now);
        thoughtRows.push(vertex);
        changeRows.push(changeRow(this.brainId, rel, rev, store.thoughts.has(rel) ? 'updated' : 'added', vertex.title ?? path.posix.basename(rel, '.md'), author, undefined, now, doc));
        const relations = extractThoughtRelations(rel, doc);
        for (const target of relations.supersedes) {
          supersedeEdges.push({ src: vertex.vid, dst: thoughtVid(this.brainId, target), values: [] });
        }
        for (const target of relations.linksTo) {
          linkEdges.push({ src: vertex.vid, dst: thoughtVid(this.brainId, target), values: [author] });
        }
      } else {
        bundleRows.push({ vid: bundleVid(this.brainId, rel), values: [rel, doc, rev] });
        changeRows.push(changeRow(this.brainId, rel, rev, store.files.has(rel) ? 'updated' : 'added', path.posix.basename(rel), author, undefined, now, doc));
      }
      await this.stamp(rel, rev);
    }

    // Batched writes: deletes first, then vertices, then edges, then the
    // change log, then the revision counter. NebulaGraph has no
    // multi-statement transaction, so the batches are ordered so that an
    // interrupted commit leaves the store one clean revision short, never
    // half-written.
    const client = await this.clientOrThrow();
    await batched((rows) => ngqlDeleteVertices('thought_delete', rows), deletes, client);
    await batchedVertices('thought_upsert', 'thought', THOUGHT_COLUMNS, thoughtRows, client);
    await batchedVertices('bundle_upsert', 'bundle_file', BUNDLE_COLUMNS, bundleRows, client);
    await batchedEdges('edge_upsert', 'SUPERSEDES', [], supersedeEdges, client);
    await batchedEdges('edge_upsert', 'LINKS_TO', ['by'], linkEdges, client);
    await batchedVertices('change_upsert', 'change_log', CHANGE_COLUMNS, changeRows, client);
    await this.setHeadRev(rev, message);
    await this.pruneChangeLog();

    this.lastRev = rev;
    this.commitRev = rev;
    await this.saveWorkspaceMeta();
    this.pending.clear();
    this.pendingDocs.clear();
    this.base.clear();
    this.conflicted = [];
    return String(rev);
  }

  /** Keep the change log bounded (specs/16): the newest rows only. */
  private async pruneChangeLog(): Promise<void> {
    const cutoff = this.lastRev - CHANGE_LOG_LIMIT;
    if (cutoff <= 0) return;
    const rows = await this.execute(
      'changes_older',
      'LOOKUP ON change_log WHERE change_log.revision <= $cutoff YIELD id(vertex) AS vid',
      { cutoff },
    );
    const vids = rows.map((r) => String(r['vid'])).filter((v) => v.length > 0);
    await batched((chunk) => ngqlDeleteVertices('change_delete', chunk), vids, await this.clientOrThrow());
  }

  /** One `change_log` vertex per changed path; `push` fills in the log entry. */
  private async appendChange(rel: string, rev: number, change: 'added' | 'updated' | 'removed', entry: LogEntry | undefined, now: Date): Promise<void> {
    const row = changeRow(this.brainId, rel, rev, change, entry?.title ?? path.posix.basename(rel, '.md'), entry?.by, entry?.note, now, undefined);
    await this.execute(
      'change_upsert',
      `INSERT VERTEX ${nqId('change_log')}(${CHANGE_COLUMNS.map(nqId).join(', ')}) VALUES ${nqLit(row.vid)}:(${row.values.map(nqLit).join(', ')})`,
    );
  }

  /**
   * The transport step (specs/16): the batched writes above already landed, so
   * the log entries attach to the revision this workspace committed — as
   * change-log rows with the entry's title/by/note, which is what `log.md` is
   * regenerated from. A pull in between has only advanced `lastRev`; the
   * commit-time revision is what these rows carry.
   */
  async push(input: PushInput): Promise<PushResult> {
    const now = (this.opts.now ?? ((): Date => new Date()))();
    const rev = this.commitRev ?? (this.lastRev > 0 ? this.lastRev : await this.headRev());
    for (const entry of input.logEntries) {
      await this.appendChange(entry.path.replace(/^\/+/, ''), rev, entry.change, entry, now);
    }
    return { pushed: true, revision: String(rev) };
  }

  /**
   * Pull (specs/16): re-read the space's thought vertices — everything the
   * bounded change log recorded past the workspace's `last_rev`. A store change
   * under a path this workspace edited is the store-wins conflict of specs/16:
   * nothing is overwritten here, the paths are named, and the settlement (the
   * store's version wins, the loss recorded in log.md) runs from
   * `resolveConflicts`.
   */
  async pull(lastRev?: string, _ctx?: ConflictContext): Promise<StoreChange[]> {
    if (this.conflicted.length > 0) {
      throw conflictError(this.conflicted, 'the store moved on underneath this workspace and keeps its version (store wins, specs/16); re-run: thoughts sync');
    }
    await this.loadWorkspaceMeta();
    const from = lastRev !== undefined ? Number(lastRev) : this.lastRev;
    const head = await this.headRev();
    if (!Number.isFinite(from) || from >= head) {
      this.lastRev = Math.max(this.lastRev, head);
      await this.saveWorkspaceMeta();
      return [];
    }

    const rows = await this.execute(
      'changes_since',
      'LOOKUP ON change_log WHERE change_log.revision > $since YIELD properties(vertex).path AS path, properties(vertex).change AS change, ' +
        'properties(vertex).revision AS revision, properties(vertex).document AS document | ORDER BY $-.revision ASC, $-.path ASC',
      { since: from },
    );
    const incoming = new Map<string, { change: StoreChange['change']; rev: number; document: string | undefined }>();
    for (const row of rows) {
      const rel = String(row['path']);
      const rev = Number(row['revision']);
      const seen = incoming.get(rel);
      if (seen === undefined || rev >= seen.rev) {
        incoming.set(rel, { change: row['change'] as StoreChange['change'], rev, document: row['document'] === null || row['document'] === undefined ? undefined : String(row['document']) });
      }
    }

    // Conflict check before anything is written: a path this workspace edited
    // underneath a store change must not be silently overwritten (specs/16).
    // A path this run wrote is pending; any other path whose materialisation
    // stamp no longer matches is an uncommitted local edit.
    const conflicted: string[] = [];
    for (const [rel, change] of incoming) {
      if (this.pending.has(rel)) {
        conflicted.push(rel);
        continue;
      }
      if (change.document === undefined) continue;
      const local = await this.localDoc(rel);
      if (local.read && local.value !== undefined && local.value !== change.document) conflicted.push(rel);
    }
    if (conflicted.length > 0) {
      this.conflicted = [...new Set(conflicted)].sort();
      throw conflictError(this.conflicted, 'the store moved on underneath this workspace and keeps its version (store wins, specs/16); re-run: thoughts sync');
    }

    const changes: StoreChange[] = [];
    for (const [rel, change] of [...incoming.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (change.document === undefined) {
        this.stamps.delete(rel);
        await fs.promises.rm(path.join(this.workspace, rel), { force: true });
      } else {
        await writeWorkspaceFile(this.workspace, rel, change.document);
        await this.stamp(rel, change.rev, change.document);
      }
      changes.push({ path: rel, change: change.change });
    }
    this.lastRev = head;
    await this.saveWorkspaceMeta();
    return changes;
  }

  async conflictInfo(): Promise<ConflictInfo> {
    return { conflicted: [...this.conflicted], inProgress: false, storeWins: this.conflicted.length > 0 };
  }

  /**
   * specs/16 nebula row — **store wins**: the store's version is materialised
   * over the lost local edit, and the loss is recorded both in `log.md` (a note
   * per lost path) and in the store's bounded change log, so no machine can
   * miss it. Returns the paths, which still need a human: the lost edits must
   * be re-applied.
   */
  async resolveConflicts(ctx: ConflictContext): Promise<string[]> {
    if (this.conflicted.length === 0) return [];
    await this.loadWorkspaceMeta();
    const head = await this.headRev();
    const now = (this.opts.now ?? ((): Date => new Date()))();
    const rev = head + 1;
    const lost: LogEntry[] = [];
    const changeRows: VertexRow[] = [];
    const store = await this.storeSnapshot();
    for (const rel of this.conflicted) {
      const localDoc = await readWorkspaceFile(this.workspace, rel);
      const remote = remoteDocOf(store, rel);
      const title = path.posix.basename(rel, '.md');
      if (remote !== undefined) {
        await writeWorkspaceFile(this.workspace, rel, remote);
        await this.stamp(rel, rev, remote);
      } else {
        this.stamps.delete(rel);
        await fs.promises.rm(path.join(this.workspace, rel), { force: true });
      }
      if (localDoc !== undefined) {
        // Record what was lost, with enough of it to re-apply by hand.
        const note = `store wins: local change overwritten (${localDoc.split('\n').length} lines, ${Buffer.byteLength(localDoc)} bytes) — specs/16`;
        lost.push({ change: 'updated', path: '/' + rel, title, note });
        changeRows.push(changeRow(this.brainId, rel, rev, 'updated', title, undefined, note, now, localDoc));
      }
    }
    const client = await this.clientOrThrow();
    await batchedVertices('change_upsert', 'change_log', CHANGE_COLUMNS, changeRows, client);
    await this.setHeadRev(rev, `store wins: ${this.conflicted.length} overwritten (specs/16)`);
    this.lastRev = Math.max(this.lastRev, rev);
    await this.saveWorkspaceMeta();
    // The note lands in log.md (specs/16: "appends a note to log.md recording
    // what was lost. Never silently.").
    await regenerate(this.workspace, ctx.brain, { log: { date: ctx.log.date, entries: [...ctx.log.entries, ...lost] } });
    await this.stamp('log.md', this.lastRev);
    const paths = this.conflicted;
    this.conflicted = [];
    this.pending.clear();
    this.pendingDocs.clear();
    this.base.clear();
    return paths;
  }

  async revisionsSince(since: string): Promise<string[]> {
    const rows = await this.execute(
      'revs_since',
      'LOOKUP ON brain_commit WHERE brain_commit.id > $since YIELD properties(vertex).id AS id | ORDER BY $-.id DESC',
      { since: Number(since) },
    );
    return rows.map((row) => String(row['id']));
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

  /** The store's own `updated` property — never a file stat (specs/16). */
  async modifiedAt(relPath: string): Promise<Date | undefined> {
    const rel = relPath.replace(/^\/+/, '');
    await this.loadWorkspaceMeta();
    try {
      const vertex = await this.thoughtVertex(rel);
      const updated = vertex?.['updated'];
      if (typeof updated === 'string' && updated.length > 0) return new Date(updated);
    } catch {
      return undefined;
    }
    return undefined;
  }

  async messageOf(revision: string): Promise<string> {
    const rows = await this.execute(
      'msg',
      'FETCH PROP ON brain_commit ' + nqLit(commitVid(this.brainId, Number(revision))) + ' YIELD properties(vertex).message AS message',
    );
    const message = rows[0]?.['message'];
    if (message === undefined || message === null) throw new ThoughtsError(`unknown revision: ${revision}`, ExitCode.Validation);
    return String(message);
  }

  // -- codegraph (specs/17 "Storage", D23) ----------------------------------

  /**
   * specs/17 "Storage": the generated graph decomposed into its native tags and
   * edges — files/symbols/modules as `code_*` vertices (vertex ids are the
   * graph node hashes), contains/imports/calls/imports_repo as edges. The
   * repo's previous vertices are deleted WITH EDGE first, so the space never
   * keeps a stale node or a dangling edge.
   */
  async saveGraph(repoId: string, doc: string): Promise<void> {
    const client = await this.clientOrThrow();
    const graph = parseGraphDoc(doc);
    const rev = await this.headRev();

    const stale = await this.graphVertexIds(repoId);
    await batched((chunk) => ngqlDeleteVertices('graph_clear', chunk), stale, client);

    const byTag = new Map<string, VertexRow[]>();
    graph.nodes.forEach((node, ord) => {
      const tag = GRAPH_TAG_OF_NODE_KIND[String(node['kind'] ?? '')];
      if (tag === undefined) return;
      const rows = byTag.get(tag) ?? [];
      const columns = GRAPH_TAG_COLUMNS[tag]!;
      rows.push({ vid: String(node['id'] ?? ''), values: graphValues(node, columns, repoId, ord) });
      byTag.set(tag, rows);
    });
    for (const [tag, rows] of [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await batchedVertices('graph_node', tag, GRAPH_TAG_COLUMNS[tag]!, rows, client);
    }

    const byEdge = new Map<string, EdgeRow[]>();
    graph.edges.forEach((edge) => {
      const type = GRAPH_EDGE_OF_TYPE[String(edge['type'] ?? '')];
      if (type === undefined) return;
      const rows = byEdge.get(type) ?? [];
      rows.push({ src: String(edge['source'] ?? ''), dst: String(edge['target'] ?? ''), values: [repoId, str(edge['codeCommit']) ?? null] });
      byEdge.set(type, rows);
    });
    for (const [type, rows] of [...byEdge.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      await batchedEdges('graph_edge', type, GRAPH_EDGE_COLUMNS[type]!, rows, client);
    }

    // The byte-exact graph document rides along as the round-trip source
    // (specs/17: generated data is never re-derived from a reassembly).
    await this.execute(
      'graph_meta_set',
      `INSERT VERTEX codegraph_meta(repo_id, code_commit, document, meta_document, revision) VALUES ` +
        `${nqLit(graphMetaVid(this.brainId, repoId))}:(${nqLit(repoId)}, ${nqLit(str(graph['codeCommit']))}, ${nqLit(doc)}, NULL, ${nqLit(rev)})`,
    );
  }

  /**
   * specs/17 "Storage": the graph document of one repo. The byte-exact stored
   * document wins; the reassembly from the `code_*` tags and their edges (in
   * `ord` order) is the fallback that proves the tags/edges carry the graph.
   */
  async loadGraph(repoId: string): Promise<string | undefined> {
    const rows = await this.execute(
      'graph_meta_get',
      'FETCH PROP ON codegraph_meta ' + nqLit(graphMetaVid(this.brainId, repoId)) + ' YIELD properties(vertex) AS props',
    );
    const props = isRecord(rows[0]?.['props']) ? (rows[0]!['props'] as Record<string, unknown>) : {};
    const doc = props['document'];
    if (typeof doc === 'string' && doc.length > 0) return doc;
    const nodes = await this.graphNodes(repoId);
    const edges = await this.graphEdges(repoId);
    if (nodes.length === 0 && edges.length === 0) return undefined;
    return JSON.stringify({ nodes, edges }, null, 2) + '\n';
  }

  async saveGraphMeta(repoId: string, doc: string, rev?: number): Promise<void> {
    const atRev = rev ?? (await this.headRev());
    const commit = /codeCommit["']?\s*[:=]\s*"?([0-9a-f]+)/i.exec(doc)?.[1] ?? /codeCommit:\s*(\S+)/.exec(doc)?.[1] ?? null;
    await this.execute(
      'graph_meta_set',
      `UPSERT VERTEX ON codegraph_meta ${nqLit(graphMetaVid(this.brainId, repoId))} SET repo_id = $repo_id, code_commit = $commit, meta_document = $doc, revision = $rev`,
      { repo_id: repoId, commit, doc, rev: atRev },
    );
  }

  async loadGraphMeta(repoId: string): Promise<string | undefined> {
    const rows = await this.execute(
      'graph_meta_get',
      'FETCH PROP ON codegraph_meta ' + nqLit(graphMetaVid(this.brainId, repoId)) + ' YIELD properties(vertex) AS props',
    );
    const props = isRecord(rows[0]?.['props']) ? (rows[0]!['props'] as Record<string, unknown>) : {};
    const doc = props['meta_document'];
    return typeof doc === 'string' && doc.length > 0 ? doc : undefined;
  }

  /** Vertex ids of one repo's graph, per tag (LOOKUP — never a walk). */
  private async graphVertexIds(repoId: string): Promise<string[]> {
    const client = await this.clientOrThrow();
    const vids: string[] = [];
    for (const tag of Object.keys(GRAPH_TAG_COLUMNS)) {
      const r = await client.execute(
        tagged('graph_vids', `LOOKUP ON ${nqId(tag)} WHERE ${nqId(tag)}.repo_id == $repo_id YIELD id(vertex) AS vid`),
        { repo_id: repoId },
      );
      for (const row of r.rows) {
        const vid = String(row['vid'] ?? '');
        if (vid.length > 0) vids.push(vid);
      }
    }
    return vids;
  }

  /** The repo's graph nodes from the tags, in `ord` order (LOOKUP). */
  private async graphNodes(repoId: string): Promise<Record<string, unknown>[]> {
    const client = await this.clientOrThrow();
    const nodes: { ord: number; node: Record<string, unknown> }[] = [];
    for (const [tag, kind] of Object.entries(GRAPH_NODE_KIND_OF_TAG)) {
      const r = await client.execute(
        tagged('graph_nodes', `LOOKUP ON ${nqId(tag)} WHERE ${nqId(tag)}.repo_id == $repo_id YIELD properties(vertex) AS props, ` +
          `${nqId(tag)}.ord AS ord | ORDER BY $-.ord ASC`),
        { repo_id: repoId },
      );
      for (const row of r.rows) {
        const props = isRecord(row['props']) ? (row['props'] as Record<string, unknown>) : {};
        // the vertex id IS the graph node id (specs/17: ids are the node hashes)
        nodes.push({ ord: Number(row['ord'] ?? 0), node: { ...props, kind, id: row['vid'] ?? props['id'] } });
      }
    }
    return nodes.sort((a, b) => a.ord - b.ord).map((n) => n.node);
  }

  /** The repo's graph edges from the edge types (LOOKUP over the edge indexes). */
  private async graphEdges(repoId: string): Promise<Record<string, unknown>[]> {
    const client = await this.clientOrThrow();
    const edges: Record<string, unknown>[] = [];
    for (const [type, graphType] of Object.entries(GRAPH_EDGE_OF_TYPE)) {
      const r = await client.execute(
        tagged('graph_edges', `LOOKUP ON ${nqId(type)} WHERE ${nqId(type)}.repo_id == $repo_id YIELD src(edge) AS src, dst(edge) AS dst`),
        { repo_id: repoId },
      );
      for (const row of r.rows) {
        edges.push({ type: graphType, source: String(row['src'] ?? ''), target: String(row['dst'] ?? '') });
      }
    }
    return edges.sort((a, b) => String(a['source']).localeCompare(String(b['source'])) || String(a['target']).localeCompare(String(b['target'])));
  }

  // -- nebula-specific serving (specs/16 Representation rule 3) -------------

  /**
   * A native-index query: `LOOKUP ON thought` over the tag indexes with pipe
   * filters, returning only matched vertices — the shape `search` (specs/05)
   * serves from.
   */
  async searchThoughts(q: ThoughtQuery = {}): Promise<{ path: string; document: string; revision: number }[]> {
    const { stmt, params } = buildThoughtQuery(q);
    const rows = await this.query(stmt, params);
    return rows.map((row) => ({ path: String(row['path']), document: String(row['document'] ?? ''), revision: Number(row['revision'] ?? 0) }));
  }

  /** A thought's relations as edges (specs/16 Representation rule 2). */
  async thoughtRelations(vid: string): Promise<{ type: string; dst: string; path?: string }[]> {
    const { stmt, params } = buildRelationsQuery(vid);
    const rows = await this.query(stmt, params);
    return rows.map((row) => ({
      type: String(row['type']),
      dst: String(row['dst']),
      ...(row['path'] === undefined || row['path'] === null ? {} : { path: String(row['path']) }),
    }));
  }

  /**
   * Cross-repo codegraph deps (specs/17): the sibling modules whose
   * IMPORTS_REPO edges point at `repoId`'s modules — a reverse GO FROM over the
   * stored graphs.
   */
  async crossRepoImports(repoId: string): Promise<{ fromRepo: string; module: string }[]> {
    const modules = new Map<string, string>();
    for (const node of await this.graphNodes(repoId)) {
      if (String(node['kind'] ?? '') === 'module') modules.set(String(node['id'] ?? ''), String(node['name'] ?? ''));
    }
    const moduleVids = [...modules.keys()];
    if (moduleVids.length === 0) return [];
    const { stmt, params } = buildImportsRepoQuery(moduleVids);
    const rows = await this.query(stmt, params);
    const deps = new Map<string, string>();
    for (const row of rows) {
      const fromRepo = String(row['from_repo'] ?? '');
      const module = String(row['module'] ?? '');
      if (fromRepo.length === 0 || fromRepo === repoId) continue;
      deps.set(`${fromRepo} ${module}`, module);
    }
    return [...deps.entries()]
      .map(([key, module]) => ({ fromRepo: key.split(' ')[0]!, module }))
      .sort((a, b) => a.fromRepo.localeCompare(b.fromRepo) || a.module.localeCompare(b.module));
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Bounded retry while a fresh space settles: ~2 heartbeats before CREATE TAG succeeds (specs/16). */
const CREATE_RETRIES = 3;
const CREATE_RETRY_MS = 1_000;
const SLEEP = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function retryWhileSpaceSettles(run: () => Promise<unknown>, delayMs = CREATE_RETRY_MS): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt >= CREATE_RETRIES - 1) throw err;
      if (delayMs > 0) await SLEEP(delayMs);
    }
  }
}

/**
 * The `REBUILD TAG INDEX` / `REBUILD EDGE INDEX` statements for the index
 * declarations of the shipped DDL, in declaration order. A fresh space needs
 * them before `LOOKUP` serves anything (specs/16 Representation rule 3).
 */
export function rebuildStatements(statements: readonly string[]): string[] {
  const rebuilds: string[] = [];
  for (const stmt of statements) {
    const m = /^CREATE (TAG|EDGE) INDEX IF NOT EXISTS ([A-Za-z_][A-Za-z0-9_]*)/im.exec(stmt.replace(/^--.*$/gm, '').trim());
    if (m === null) continue;
    rebuilds.push(`REBUILD ${m[1] === 'EDGE' ? 'EDGE' : 'TAG'} INDEX ${nqId(m[2]!)}`);
  }
  return rebuilds;
}

function remoteDocOf(store: StoreSnapshot, rel: string): string | undefined {
  return store.thoughts.get(rel)?.document ?? store.files.get(rel)?.document;
}

function changeRow(
  brainId: string,
  rel: string,
  revision: number,
  change: 'added' | 'updated' | 'removed',
  title: string,
  by: string | undefined,
  note: string | undefined,
  now: Date,
  document: string | undefined,
): VertexRow {
  return {
    vid: changeVid(brainId, rel, revision),
    values: CHANGE_COLUMNS.map((column) => {
      switch (column) {
        case 'path':
          return rel;
        case 'revision':
          return revision;
        case 'change':
          return change;
        case 'title':
          return title;
        case 'by':
          return by ?? null;
        case 'note':
          return note ?? null;
        case 'occurred_at':
          return now.toISOString();
        case 'document':
          return document ?? null;
      }
    }),
  };
}

/** Map a graph node to one row of its tag, in the tag's column order. */
function graphValues(node: Record<string, unknown>, columns: readonly string[], repoId: string, ord: number): unknown[] {
  return columns.map((column) => {
    switch (column) {
      case 'repo_id':
        return repoId;
      case 'ord':
        return ord;
      case 'code_commit':
        return str(node['codeCommit']) ?? null;
      case 'symbol_kind':
        return str(node['symbolKind']) ?? null;
      case 'end_line':
        return typeof node['endLine'] === 'number' ? node['endLine'] : null;
      case 'line':
        return typeof node['line'] === 'number' ? node['line'] : null;
      case 'manifest':
        return str(node['manifest']) ?? null;
      case 'language':
        return str(node['language']) ?? null;
      case 'sha':
        return str(node['sha']) ?? null;
      case 'path':
        return str(node['path']) ?? null;
      case 'name':
        return str(node['name']) ?? '';
      default:
        return null;
    }
  });
}

/** Run one statement per `NEBULA_ROWS_PER_STATEMENT` rows (specs/16 batching). */
async function batched(run: (chunk: string[]) => string, items: string[], client: NebulaClientLike): Promise<void> {
  for (let i = 0; i < items.length; i += NEBULA_ROWS_PER_STATEMENT) {
    const stmt = run(items.slice(i, i + NEBULA_ROWS_PER_STATEMENT));
    if (stmt.length > 0) await client.execute(stmt);
  }
}

async function batchedVertices(op: string, tag: string, columns: readonly string[], rows: VertexRow[], client: NebulaClientLike): Promise<void> {
  for (let i = 0; i < rows.length; i += NEBULA_ROWS_PER_STATEMENT) {
    const stmt = ngqlUpsertVertices(op, tag, columns, rows.slice(i, i + NEBULA_ROWS_PER_STATEMENT));
    if (stmt.length > 0) await client.execute(stmt);
  }
}

async function batchedEdges(op: string, edge: string, columns: readonly string[], rows: EdgeRow[], client: NebulaClientLike): Promise<void> {
  for (let i = 0; i < rows.length; i += NEBULA_ROWS_PER_STATEMENT) {
    const stmt = ngqlUpsertEdges(op, edge, columns, rows.slice(i, i + NEBULA_ROWS_PER_STATEMENT));
    if (stmt.length > 0) await client.execute(stmt);
  }
}

/** Parse a graph document loosely: a broken graph stores as an empty one. */
function parseGraphDoc(doc: string): { codeCommit: string | null; nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } {
  const empty = { codeCommit: null, nodes: [], edges: [] };
  try {
    const parsed: unknown = JSON.parse(doc);
    if (!isRecord(parsed)) return empty;
    const items = (key: string): Record<string, unknown>[] =>
      Array.isArray(parsed[key]) ? (parsed[key] as unknown[]).map((v) => (isRecord(v) ? v : {})) : [];
    return { codeCommit: str(parsed['codeCommit']), nodes: items('nodes'), edges: items('edges') };
  } catch {
    return empty;
  }
}
