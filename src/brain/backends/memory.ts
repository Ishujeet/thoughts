/**
 * In-memory backend (specs/16): the reference implementation of the
 * BrainBackend contract. The store is a revision list in memory, the
 * workspace is an ordinary directory, and a conflict is a base-revision
 * mismatch (the `psql` semantics of specs/16, without a server). Milestone 1
 * uses it for the contract test suite only; `resolveBackend` never returns it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, ThoughtsError } from '../../types.js';
import { graphMetaRelPath, graphRelPath, listWorkspaceThoughts, readWorkspaceFile, writeWorkspaceFile } from './workspace.js';
import {
  conflictError,
  type BackendHealth,
  type BackendKindOrMemory,
  type BrainBackend,
  type ConflictContext,
  type ConflictInfo,
  type PushInput,
  type PushResult,
  type StoreChange,
  type WorkspaceChange,
} from './types.js';

interface StoreRevision {
  id: string;
  message: string;
  /** Full file map of the store at this revision. */
  files: Map<string, string>;
  /** Paths this revision changed, with the kind of change. */
  changes: StoreChange[];
}

/** State a set of backends share: one brain's store seen by many "machines". */
export class InMemoryStore {
  readonly revisions: StoreRevision[] = [];
  counter = 1;

  constructor() {
    this.revisions.push({ id: '1', message: 'seed', files: new Map(), changes: [] });
  }

  head(): StoreRevision {
    return this.revisions[this.revisions.length - 1]!;
  }

  /** Last revision that touched `path`, or 0 when none did. */
  revisionOf(path: string): number {
    for (let i = this.revisions.length - 1; i > 0; i -= 1) {
      if (this.revisions[i]!.changes.some((c) => c.path === path)) return i;
    }
    return 0;
  }

  revisionById(id: string): StoreRevision | undefined {
    return this.revisions.find((r) => r.id === id);
  }
}

export class InMemoryBackend implements BrainBackend {
  // `memory` is the in-process reference kind; specs/16's store kinds are git/psql/nebula.
  readonly kind: BackendKindOrMemory = 'memory';
  readonly brainId: string;
  readonly workspace: string;
  private readonly store: InMemoryStore;
  /** Workspace-relative paths changed since the last commit. */
  private readonly pending = new Map<string, 'written' | 'deleted'>();
  /** Store revision of each pending path when this backend last touched it. */
  private readonly base = new Map<string, number>();
  /** Paths a commit refused because the store had moved on. */
  private conflicted: string[] = [];
  /** Last store revision materialised into this workspace. */
  private applied: number;

  constructor(opts: { brainId: string; workspace: string; store?: InMemoryStore }) {
    this.brainId = opts.brainId;
    this.workspace = opts.workspace;
    this.store = opts.store ?? new InMemoryStore();
    this.applied = this.store.counter;
  }

  async health(): Promise<BackendHealth> {
    try {
      await fs.promises.access(this.workspace);
      return { ok: true, detail: 'in-memory store' };
    } catch {
      return { ok: false, detail: this.workspace + ' is not accessible' };
    }
  }

  listThoughts(): Promise<string[]> {
    return listWorkspaceThoughts(this.workspace);
  }

  async read(relPath: string, opts: { revision?: string } = {}): Promise<string | undefined> {
    if (opts.revision !== undefined) {
      const rev = opts.revision === 'HEAD' ? this.store.head() : this.store.revisionById(opts.revision);
      return rev?.files.get(relPath);
    }
    return readWorkspaceFile(this.workspace, relPath);
  }

  async write(relPath: string, doc: string): Promise<void> {
    this.base.set(relPath, this.store.revisionOf(relPath));
    this.pending.set(relPath, 'written');
    await writeWorkspaceFile(this.workspace, relPath, doc);
  }

  async delete(relPath: string): Promise<void> {
    this.base.set(relPath, this.store.revisionOf(relPath));
    this.pending.set(relPath, 'deleted');
    await fs.promises.rm(path.join(this.workspace, relPath), { force: true });
  }

  /** The workspace compared against the store head — the analogue of `git status`. */
  async dirty(): Promise<WorkspaceChange[]> {
    const head = this.store.head();
    const workspace = new Map<string, string>();
    for (const rel of await listWorkspaceThoughts(this.workspace)) {
      workspace.set(rel, (await readWorkspaceFile(this.workspace, rel)) ?? '');
    }
    const paths = new Set<string>([...workspace.keys(), ...head.files.keys(), ...this.pending.keys()]);
    const changes: WorkspaceChange[] = [];
    for (const p of [...paths].sort()) {
      const before = head.files.get(p);
      const after = workspace.get(p);
      if (before === after) continue;
      const deleted = after === undefined;
      changes.push({ path: p, code: deleted ? 'D' : before === undefined ? 'A' : 'M', deleted });
    }
    return changes;
  }

  async revision(): Promise<string | undefined> {
    return String(this.applied);
  }

  async upstreamRevision(): Promise<string | undefined> {
    return this.store.head().id;
  }

  async remoteUrl(): Promise<string | undefined> {
    return undefined; // one process, one store: nothing to address
  }

  async diff(from: string, to?: string): Promise<WorkspaceChange[]> {
    const a = this.store.revisionById(from);
    const b = to === undefined || to === 'HEAD' ? this.store.head() : this.store.revisionById(to);
    if (!a || !b) return [];
    const paths = new Set<string>([...a.files.keys(), ...b.files.keys()]);
    const changes: WorkspaceChange[] = [];
    for (const p of [...paths].sort()) {
      const before = a.files.get(p);
      const after = b.files.get(p);
      if (before === after) continue;
      const deleted = after === undefined;
      changes.push({ path: p, code: deleted ? 'D' : before === undefined ? 'A' : 'M', deleted });
    }
    return changes;
  }

  async commit(message: string): Promise<string | undefined> {
    if (this.pending.size === 0) return undefined;
    // specs/16: every written thought carries the revision it was read at; a
    // mismatch aborts the whole write and names the paths.
    const stale = [...this.pending.keys()].filter((p) => (this.base.get(p) ?? 0) !== this.store.revisionOf(p));
    if (stale.length > 0) {
      this.conflicted = stale;
      throw conflictError(stale, 'the store moved on underneath this workspace; re-run: thoughts sync');
    }
    const files = new Map(this.store.head().files);
    const changes: StoreChange[] = [];
    for (const [p, kind] of this.pending) {
      const existed = files.has(p);
      if (kind === 'deleted') {
        files.delete(p);
        changes.push({ path: p, change: 'removed' });
      } else {
        const doc = (await readWorkspaceFile(this.workspace, p)) ?? '';
        files.set(p, doc);
        changes.push({ path: p, change: existed ? 'updated' : 'added' });
      }
    }
    this.store.counter += 1;
    const id = String(this.store.counter);
    this.store.revisions.push({ id, message, files, changes });
    this.pending.clear();
    this.base.clear();
    this.conflicted = [];
    this.applied = this.store.counter;
    return id;
  }

  /** The store is this process's memory: the transport step is a no-op. */
  async push(_input: PushInput): Promise<PushResult> {
    return { pushed: true, revision: this.store.head().id };
  }

  async pull(lastRev?: string, _ctx?: ConflictContext): Promise<StoreChange[]> {
    const from = lastRev !== undefined ? Number(lastRev) : this.applied;
    const changes: StoreChange[] = [];
    for (const rev of this.store.revisions) {
      if (Number(rev.id) <= from || Number(rev.id) === 1) continue;
      for (const c of rev.changes) {
        changes.push(c);
        if (c.change === 'removed') await fs.promises.rm(path.join(this.workspace, c.path), { force: true });
        else await writeWorkspaceFile(this.workspace, c.path, rev.files.get(c.path) ?? '');
      }
    }
    if (changes.length > 0) this.applied = this.store.counter;
    return changes;
  }

  async conflictInfo(): Promise<ConflictInfo> {
    return { conflicted: [...this.conflicted], inProgress: false };
  }

  async resolveConflicts(_ctx: ConflictContext): Promise<string[]> {
    // specs/16: a base-revision mismatch is rolled back, never auto-settled.
    return [...this.conflicted];
  }

  async revisionsSince(since: string): Promise<string[]> {
    const from = Number(since);
    return this.store.revisions.filter((r) => Number(r.id) > from).map((r) => r.id).reverse();
  }

  /** Store revisions this workspace has not applied yet. */
  async behindCount(): Promise<number | undefined> {
    return Math.max(0, this.store.counter - this.applied);
  }

  async modifiedAt(relPath: string): Promise<Date | undefined> {
    const n = this.store.revisionOf(relPath);
    if (n === 0) return undefined;
    const rev = this.store.revisions[n];
    if (rev === undefined) return undefined;
    const doc = rev.files.get(relPath);
    if (doc === undefined) return undefined;
    // No wall clock in the store: fall back to the workspace mtime, which for
    // the in-memory reference matches what the contract suite can assert on.
    try {
      return (await fs.promises.stat(path.join(this.workspace, relPath))).mtime;
    } catch {
      return undefined;
    }
  }

  async messageOf(revision: string): Promise<string> {
    const rev = this.store.revisionById(revision);
    if (rev === undefined) throw new ThoughtsError(`unknown revision: ${revision}`, ExitCode.Validation);
    return rev.message;
  }

  async saveGraph(repoId: string, doc: string): Promise<void> {
    await writeWorkspaceFile(this.workspace, graphRelPath(repoId), doc);
  }

  async loadGraph(repoId: string): Promise<string | undefined> {
    return readWorkspaceFile(this.workspace, graphRelPath(repoId));
  }

  async saveGraphMeta(repoId: string, doc: string): Promise<void> {
    await writeWorkspaceFile(this.workspace, graphMetaRelPath(repoId), doc);
  }

  async loadGraphMeta(repoId: string): Promise<string | undefined> {
    return readWorkspaceFile(this.workspace, graphMetaRelPath(repoId));
  }
}
