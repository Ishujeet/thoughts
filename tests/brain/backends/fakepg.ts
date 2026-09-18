/**
 * A fake `pg` client at the seam src/brain/backends/pg.ts talks to. It
 * implements the same statements the backend issues — dispatching on the
 * `-- thoughts:<op>` tag every statement carries — over in-memory tables with
 * BEGIN/ROLLBACK semantics, so the contract suite runs with no server. The
 * fake mirrors the DDL of src/brain/backends/schema/pg.sql.
 */
import type { PgClientLike } from '../../../src/brain/backends/pg.js';

export interface FakeThoughtRow {
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
  revision: number;
  author: string | null;
}

export interface FakeChangeRow {
  path: string;
  revision: number;
  change: string;
  title: string | null;
  by: string | null;
  note: string | null;
  occurred_at: string | null;
}

/** The store one or many clients share (one brain's database). */
export class FakePgStore {
  thoughts = new Map<string, FakeThoughtRow>();
  bundleFiles = new Map<string, { path: string; document: string; revision: number }>();
  history: { path: string; revision: number; author: string | null; occurred_at: string; document: string }[] = [];
  changeLog: FakeChangeRow[] = [];
  commits = new Map<number, { id: number; message: string; author: string | null; occurred_at: string }>();
  meta = new Map<string, string>();
  graphNodes = new Map<string, { id: string; kind: string; name: string; file: string | null; sha: string | null; ord: number; props: unknown }[]>();
  graphEdges = new Map<string, { id: string; type: string; source: string; target: string; ord: number; props: unknown }[]>();
  graphMeta = new Map<string, { repo_id: string; code_commit: string | null; document: string; revision: number }>();
  /** Transaction snapshot (BEGIN/ROLLBACK); absent outside a transaction. */
  snapshot: Snapshot | undefined;

  constructor() {
    this.meta.set('rev', '1');
    this.commits.set(1, { id: 1, message: 'seed', author: 'thoughts', occurred_at: '2026-01-01T00:00:00Z' });
  }
}

type Snapshot = {
  thoughts: FakePgStore['thoughts'];
  bundleFiles: FakePgStore['bundleFiles'];
  history: FakePgStore['history'];
  changeLog: FakePgStore['changeLog'];
  commits: FakePgStore['commits'];
  meta: FakePgStore['meta'];
  graphNodes: FakePgStore['graphNodes'];
  graphEdges: FakePgStore['graphEdges'];
  graphMeta: FakePgStore['graphMeta'];
};

function rowsOf(values: unknown[]): Record<string, unknown>[] {
  return values as Record<string, unknown>[];
}

function snapshotOf(s: FakePgStore): Snapshot {
  return {
    thoughts: new Map(s.thoughts),
    bundleFiles: new Map(s.bundleFiles),
    history: [...s.history],
    changeLog: s.changeLog.map((r) => ({ ...r })),
    commits: new Map(s.commits),
    meta: new Map(s.meta),
    graphNodes: new Map(s.graphNodes),
    graphEdges: new Map(s.graphEdges),
    graphMeta: new Map(s.graphMeta),
  };
}

/** Op → how many statements of this op ran (assertions use `calls`). */
export class FakePgClient implements PgClientLike {
  readonly store: FakePgStore;
  /** Recorded when the client is created through the module mock. */
  connectionString: string | undefined;
  /** Every statement the backend issued, in order. */
  calls: { op: string; sql: string; params: unknown[] }[] = [];
  /** Fail the next statement matching this op with this error. */
  failOn?: { op: string; error: Error };

  constructor(store: FakePgStore = new FakePgStore()) {
    this.store = store;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const op = /^-- thoughts:([a-z_]+)/.exec(sql)?.[1] ?? 'unknown';
    this.calls.push({ op, sql, params });
    if (this.failOn && this.failOn.op === op) {
      const error = this.failOn.error;
      this.failOn = undefined;
      throw error;
    }
    const s = this.store;
    switch (op) {
      case 'ping':
        return { rows: [{ ok: 1 }] };
      case 'head':
      case 'meta_get': {
        const key = op === 'head' ? 'rev' : String(params[0]);
        const value = s.meta.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      case 'meta_set':
        s.meta.set(String(params[0]), String(params[1]));
        return { rows: [] };
      case 'paths': {
        const rows = [...s.thoughts.keys()].sort().map((path) => ({ path }));
        return { rows };
      }
      case 'rows_all':
        return { rows: rowsOf([...s.thoughts.values()].sort((a, b) => a.path.localeCompare(b.path))) };
      case 'files_all':
        return { rows: [...s.bundleFiles.values()].sort((a, b) => a.path.localeCompare(b.path)) };
      case 'row': {
        const row = s.thoughts.get(String(params[0]));
        return { rows: row === undefined ? [] : [row as unknown as Record<string, unknown>] };
      }
      case 'row_rev': {
        const row = s.thoughts.get(String(params[0]));
        return { rows: row === undefined ? [] : [{ revision: row.revision }] };
      }
      case 'row_at': {
        const path = String(params[0]);
        const rev = Number(params[1]);
        const hits = s.history.filter((h) => h.path === path && h.revision <= rev).sort((a, b) => b.revision - a.revision);
        return { rows: hits.length === 0 ? [] : [{ document: hits[0]!.document }] };
      }
      case 'since_rows':
        return { rows: rowsOf([...s.thoughts.values()].filter((r) => r.revision > Number(params[0])).sort((a, b) => a.revision - b.revision || a.path.localeCompare(b.path))) };
      case 'since_files':
        return { rows: [...s.bundleFiles.values()].filter((r) => r.revision > Number(params[0])).sort((a, b) => a.revision - b.revision || a.path.localeCompare(b.path)) };
      case 'since_changes': {
        const from = Number(params[0]);
        const to = params.length > 1 ? Number(params[1]) : Infinity;
        const rows = s.changeLog
          .filter((r) => r.revision > from && r.revision <= to)
          .sort((a, b) => a.revision - b.revision || a.path.localeCompare(b.path));
        return { rows: rowsOf(rows) };
      }
      case 'upsert_thought': {
        const [path, id, repo_id, kind, zone, title, status, created, updated, supersedes, superseded_by, stale_after, frontmatter, body, document, revision, author] = params as [
          string, string, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string, string, string, number, string | null,
        ];
        const row: FakeThoughtRow = {
          path, id, repo_id, kind, zone, title, status, created, updated, supersedes, superseded_by, stale_after,
          frontmatter: JSON.parse(String(frontmatter)),
          body,
          document,
          revision: Number(revision),
          author,
        };
        s.thoughts.set(path, row);
        return { rows: [] };
      }
      case 'delete_thought':
        s.thoughts.delete(String(params[0]));
        return { rows: [] };
      case 'upsert_file':
        s.bundleFiles.set(String(params[0]), { path: String(params[0]), document: String(params[1]), revision: Number(params[2]) });
        return { rows: [] };
      case 'delete_file':
        s.bundleFiles.delete(String(params[0]));
        return { rows: [] };
      case 'history':
        s.history.push({ path: String(params[0]), revision: Number(params[1]), author: params[2] === null ? null : String(params[2]), occurred_at: String(params[3]), document: String(params[4]) });
        return { rows: [] };
      case 'log': {
        const row: FakeChangeRow = {
          path: String(params[0]),
          revision: Number(params[1]),
          change: String(params[2]),
          title: params[3] === null ? null : String(params[3]),
          by: params[4] === null ? null : String(params[4]),
          note: params[5] === null ? null : String(params[5]),
          occurred_at: String(params[6]),
        };
        const upsert = sql.includes('ON CONFLICT');
        const existing = s.changeLog.find((r) => r.path === row.path && r.revision === row.revision);
        if (existing !== undefined && upsert) {
          existing.change = row.change;
          existing.title = row.title ?? existing.title;
          existing.by = row.by ?? existing.by;
          existing.note = row.note ?? existing.note;
        } else if (existing === undefined) {
          s.changeLog.push(row);
        }
        return { rows: [] };
      }
      case 'commit_row':
        s.commits.set(Number(params[0]), { id: Number(params[0]), message: String(params[1]), author: params[2] === null ? null : String(params[2]), occurred_at: String(params[3]) });
        return { rows: [] };
      case 'msg': {
        const commit = s.commits.get(Number(params[0]));
        return { rows: commit === undefined ? [] : [{ message: commit.message }] };
      }
      case 'revs_since':
        return { rows: [...s.commits.values()].filter((c) => c.id > Number(params[0])).sort((a, b) => b.id - a.id).map((c) => ({ id: c.id })) };
      case 'begin':
        s.snapshot = snapshotOf(s);
        return { rows: [] };
      case 'commit_tx':
        s.snapshot = undefined;
        return { rows: [] };
      case 'rollback':
        if (s.snapshot !== undefined) {
          s.thoughts = s.snapshot.thoughts;
          s.bundleFiles = s.snapshot.bundleFiles;
          s.history = s.snapshot.history;
          s.changeLog = s.snapshot.changeLog;
          s.commits = s.snapshot.commits;
          s.meta = s.snapshot.meta;
          s.graphNodes = s.snapshot.graphNodes;
          s.graphEdges = s.snapshot.graphEdges;
          s.graphMeta = s.snapshot.graphMeta;
          s.snapshot = undefined;
        }
        return { rows: [] };
      case 'graph_clear_nodes':
        s.graphNodes.delete(String(params[0]));
        return { rows: [] };
      case 'graph_clear_edges':
        s.graphEdges.delete(String(params[0]));
        return { rows: [] };
      case 'graph_node': {
        const repoId = String(params[0]);
        const list = s.graphNodes.get(repoId) ?? [];
        const row = { id: String(params[1]), kind: String(params[2]), name: String(params[3]), file: params[4] === null ? null : String(params[4]), sha: params[5] === null ? null : String(params[5]), ord: Number(params[6]), props: JSON.parse(String(params[7])) };
        const existing = list.findIndex((n) => n.id === row.id);
        if (existing >= 0) list[existing] = row;
        else list.push(row);
        s.graphNodes.set(repoId, list);
        return { rows: [] };
      }
      case 'graph_edge': {
        const repoId = String(params[0]);
        const list = s.graphEdges.get(repoId) ?? [];
        const row = { id: String(params[1]), type: String(params[2]), source: String(params[3]), target: String(params[4]), ord: Number(params[5]), props: JSON.parse(String(params[6])) };
        const existing = list.findIndex((e) => e.id === row.id);
        if (existing >= 0) list[existing] = row;
        else list.push(row);
        s.graphEdges.set(repoId, list);
        return { rows: [] };
      }
      case 'graph_nodes':
        return { rows: (s.graphNodes.get(String(params[0])) ?? []).slice().sort((a, b) => a.ord - b.ord).map((n) => ({ props: n.props })) };
      case 'graph_edges':
        return { rows: (s.graphEdges.get(String(params[0])) ?? []).slice().sort((a, b) => a.ord - b.ord).map((e) => ({ props: e.props })) };
      case 'graph_meta_get': {
        const meta = s.graphMeta.get(String(params[0]));
        return { rows: meta === undefined ? [] : [{ document: meta.document }] };
      }
      case 'graph_meta_set':
        s.graphMeta.set(String(params[0]), { repo_id: String(params[0]), code_commit: params[1] === null ? null : String(params[1]), document: String(params[2]), revision: Number(params[3]) });
        return { rows: [] };
      case 'lock':
        return { rows: [] };
      case 'prune_log': {
        const keep = Number(params[0]);
        const ordered = [...s.changeLog].sort((a, b) => b.revision - a.revision || b.path.localeCompare(a.path));
        s.changeLog = ordered.slice(0, keep);
        return { rows: [] };
      }
      case 'search':
        return { rows: rowsOf([...s.thoughts.values()].filter((r) => matchesWhere(sql, params, r))) };
      default: {
        // Provisioning DDL (schema/pg.sql): applied, no rows.
        if (/^\s*(CREATE|ALTER|INSERT|DELETE|DROP|COMMENT)\b/i.test(stripComments(sql))) return { rows: [] };
        throw new Error(`FakePgClient: no handler for statement tag "${op}"`);
      }
    }
  }

  async connect(): Promise<void> {}

  async end(): Promise<void> {}

  /** The `thoughts` row of a path, for assertions. */
  thought(path: string): FakeThoughtRow | undefined {
    return this.store.thoughts.get(path);
  }

  /** The store head revision. */
  get head(): number {
    return Number(this.store.meta.get('rev'));
  }
}

/** Strip `--` comment lines so a statement can be recognised. */
function stripComments(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .trim();
}

/**
 * Evaluate the WHERE clause the backend builds (specs/16 Representation):
 * column equalities, the revision filter, and the FTS match over title + body
 * (every search term must appear, like `websearch_to_tsquery`'s AND).
 */
function matchesWhere(sql: string, params: unknown[], row: FakeThoughtRow): boolean {
  const withoutTag = stripComments(sql);
  const whereIndex = withoutTag.toUpperCase().indexOf(' WHERE ');
  const where = whereIndex >= 0 ? withoutTag.slice(whereIndex) : '';
  for (const field of ['repo_id', 'kind', 'zone', 'status', 'title'] as const) {
    const m = new RegExp(`${field} = \\$(\\d+)`).exec(where);
    if (m === null) continue;
    const value = params[Number(m[1]) - 1];
    if (String(row[field] ?? '') !== String(value)) return false;
  }
  const revision = /revision > \$(\d+)/.exec(where);
  if (revision !== null && row.revision <= Number(params[Number(revision[1]) - 1])) return false;
  const fts = /websearch_to_tsquery\('english', \$(\d+)\)/.exec(where);
  if (fts !== null) {
    const text = String(params[Number(fts[1]) - 1]).toLowerCase();
    const haystack = `${row.title ?? ''} ${row.body}`.toLowerCase();
    for (const term of text.split(/\s+/)) if (term.length > 0 && !haystack.includes(term)) return false;
  }
  const limit = / LIMIT (\d+)\s*$/i.exec(withoutTag);
  void limit;
  return true;
}
