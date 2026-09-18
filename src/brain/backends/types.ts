/**
 * The BrainBackend contract (specs/16 "Workspace vs store", "Sync and conflict
 * semantics").
 *
 * A backend is the durable store and sync transport of a brain. The workspace
 * (`~/.thoughts/brains/<id>/`) is identical for every backend — ordinary OKF
 * markdown — so callers never branch on the kind except where the spec says
 * so (conflict handling, `scan --history`). For `git` the workspace is also
 * the store clone; for the other kinds it is materialised from the store.
 *
 * Path convention: every path a backend takes or returns is workspace-relative
 * WITHOUT a leading slash. Commands add the bundle-relative leading slash when
 * they talk about brain paths (specs/01).
 */
import { ExitCode, ThoughtsError, type BackendDescriptor, type BackendKind, type BrainConfig, type LogEntry } from '../../types.js';

export type { BackendDescriptor, BackendKind };

/** Store kinds (specs/16) plus the in-process reference kind of the contract suite. */
export type BackendKindOrMemory = BackendKind | 'memory';

export interface BackendHealth {
  ok: boolean;
  /** Human-readable detail; never carries a credential. */
  detail?: string;
}

/** A workspace file that differs from the store. */
export interface WorkspaceChange {
  /** Workspace-relative path (no leading slash). */
  path: string;
  /** Short status code, backend-defined (`??`, `M`, `A`, `D`, ...). */
  code: string;
  deleted: boolean;
}

/** What a run hands to the store when it pushes (specs/16 sync table). */
export interface PushInput {
  /** Workspace-relative paths this run changed. */
  paths: string[];
  /** Commit / log message in the specs/03 format. */
  message: string;
  logEntries: LogEntry[];
}

export interface PushResult {
  /** Revision id the store now carries, when the backend tracks one. */
  revision?: string;
  /** True when the transport delivered the write (false = kept locally only). */
  pushed: boolean;
}

/** One change that arrived from the store during `pull`. */
export interface StoreChange {
  /** Workspace-relative path (no leading slash). */
  path: string;
  change: 'added' | 'updated' | 'removed';
}

export interface ConflictInfo {
  /** Paths the store cannot settle automatically (workspace-relative). */
  conflicted: string[];
  /** True when a store-level merge is still mid-flight (git: rebase in progress). */
  inProgress: boolean;
  /**
   * specs/16 sync table, nebula row: the backend settles the conflict itself
   * by taking the store's side ("store wins"), overwriting the workspace copy
   * and recording what was lost in `log.md` — sync continues with a warning
   * instead of exit 4. `resolveConflicts` performs that settlement and returns
   * the paths, which still need a human: the lost edits must be re-applied.
   */
  storeWins?: boolean;
}

/** Everything resolution may need: the brain config and this run's log. */
export interface ConflictContext {
  brain: BrainConfig;
  log: { date: string; entries: LogEntry[] };
}

/**
 * Codegraph seam (specs/17 "Storage"): one generated graph document per repo.
 * git keeps it as `repos/<id>/codegraph/graph.json`; other backends use their
 * own storage. Minimal for milestone 1 so M4 slots in without a contract change.
 */
export interface BrainBackend {
  readonly kind: BackendKindOrMemory;
  readonly brainId: string;
  /** Absolute path of the local workspace. */
  readonly workspace: string;
  /**
   * How much of the store's past `read(path, {revision})` can reach (specs/16
   * sync table): 'full' is every revision (git, psql's append-only history);
   * 'partial' is a bounded window (nebula's change log) — `scan --history`
   * says so rather than pretend. Absent means 'full'.
   */
  readonly historyMode?: 'full' | 'partial';

  /** Store reachability (specs/16 exit-code table: 2 when this fails). */
  health(): Promise<BackendHealth>;

  /** Workspace thought paths (workspace-relative, `.md` only). */
  listThoughts(): Promise<string[]>;
  read(path: string, opts?: { revision?: string }): Promise<string | undefined>;
  write(path: string, doc: string): Promise<void>;
  delete(path: string): Promise<void>;

  /** Workspace files that differ from the store. */
  dirty(): Promise<WorkspaceChange[]>;
  /** Current revision id of the workspace, or undefined when it has none. */
  revision(): Promise<string | undefined>;
  /** Revision of the store the workspace is based on (git: `@{u}`). */
  upstreamRevision(): Promise<string | undefined>;
  /** Store address this workspace syncs with, when it has one (never a credential). */
  remoteUrl(): Promise<string | undefined>;
  /** Workspace-vs-store diff between two revisions, newest last. */
  diff(from: string, to?: string): Promise<WorkspaceChange[]>;

  /** Settle the dirty workspace into a local revision; undefined when nothing changed. */
  commit(message: string): Promise<string | undefined>;
  /** Deliver the local revision to the store. */
  push(input: PushInput): Promise<PushResult>;
  /** Bring the workspace up to date with the store; returns the incoming changes. */
  pull(lastRev?: string, ctx?: ConflictContext): Promise<StoreChange[]>;

  conflictInfo(): Promise<ConflictInfo>;
  /**
   * Settle what the backend can settle on its own (specs/16 "On conflict"):
   * returns the paths that still need a human, empty when resolution succeeded.
   */
  resolveConflicts(ctx: ConflictContext): Promise<string[]>;

  /** Revisions in the store but not in `since`, newest first (git: `rev-list`). */
  revisionsSince(since: string): Promise<string[]>;
  /** Store revisions the workspace does not have yet; undefined when unknowable (specs/04 "more than N commits behind"). */
  behindCount(): Promise<number | undefined>;
  /**
   * Last modification time of a thought, from the store's own metadata where
   * it exists (specs/16 "Representation": serving uses the backend's index,
   * not workspace file stats — required so non-git backends can answer this
   * with zero file reads).
   */
  modifiedAt(path: string): Promise<Date | undefined>;
  /** Full store message of a revision (specs/03 format for git). */
  messageOf(revision: string): Promise<string>;

  saveGraph(repoId: string, doc: string): Promise<void>;
  loadGraph(repoId: string): Promise<string | undefined>;
  /**
   * Graph metadata (specs/17 "Storage": generated-at, codeCommit, counts,
   * languages) alongside the graph document. A missing or unreadable meta
   * means the next sync rebuilds the graph fully.
   */
  saveGraphMeta(repoId: string, doc: string): Promise<void>;
  loadGraphMeta(repoId: string): Promise<string | undefined>;
}

/**
 * What `init` needs from a non-git backend (specs/16 "Provisioning"):
 * connect + apply the shipped schema, then materialise the workspace.
 * `storeName` is the non-secret object name the report and the docker snippet
 * show (psql: the database; nebula: the space).
 */
export interface ProvisionableBackend extends BrainBackend {
  provision(): Promise<{ applied: boolean; version: string }>;
  materialise(): Promise<StoreChange[]>;
  storeName(): Promise<string>;
}

export function isProvisionable(b: BrainBackend): b is ProvisionableBackend {
  return typeof (b as ProvisionableBackend).provision === 'function' && typeof (b as ProvisionableBackend).materialise === 'function';
}

/**
 * Exit 4 (specs/16 failure table): a conflict that needs manual resolution.
 * The message names the paths; the hint is the specs/03 remedy.
 */
export function conflictError(files: string[], hint = 'resolve with git, then run: thoughts sync'): ThoughtsError {
  return new ThoughtsError(`conflict in ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`, ExitCode.Conflict, {
    hint,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse the `backend:` block of `brain.yml` (specs/16). Absent means the git
 * default. Only kind + database/space names are allowed through; anything
 * else in the block is preserved by the config loader, not by this descriptor.
 */
export function parseBackendDescriptor(value: unknown, context = 'brain.yml'): BackendDescriptor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new ThoughtsError(`invalid ${context}: backend must be a mapping`, ExitCode.Validation, {
      hint: 'backend:\n  kind: git | psql | nebula',
    });
  }
  const kind = value.kind;
  if (kind !== 'git' && kind !== 'psql' && kind !== 'nebula') {
    throw new ThoughtsError(`invalid ${context}: backend.kind must be git, psql, or nebula`, ExitCode.Validation, {
      hint: 'backend:\n  kind: git | psql | nebula',
    });
  }
  const descriptor: BackendDescriptor = { kind };
  if (typeof value.database === 'string' && value.database.length > 0) descriptor.database = value.database;
  if (typeof value.space === 'string' && value.space.length > 0) descriptor.space = value.space;
  return descriptor;
}
