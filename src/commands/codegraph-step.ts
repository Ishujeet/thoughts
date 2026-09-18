/**
 * The codegraph step shared by `sync` (specs/03 step 7) and `init`
 * (specs/17 "When the graph is built").
 *
 * Fail soft, exactly one warning (specs/17): any failure — no git, no
 * grammars, a parse error, an unusable store — skips the step for that repo
 * with one warning naming the cause, printed once per process, and the stored
 * graph stays as it is. The graph is never a reason for a sync to fail.
 */
import YAML from 'yaml';
import type { BrainBackend } from '../brain/backends/types.js';
import { graphIndexRelPath } from '../brain/backends/workspace.js';
import * as git from '../git.js';
import * as out from '../output.js';
import type { BrainConfig, StepReport } from '../types.js';
import {
  crossRepoEdges,
  deserialize,
  moduleForRepo,
  ownModuleName,
  serialize,
  setCrossRepoEdges,
  type RepoGraph,
} from '../codegraph/graph.js';
import { renderGraphIndex, type CrossRepoDep } from '../codegraph/render.js';
import { updateGraph } from '../codegraph/update.js';

export type CodegraphStatus = 'updated' | 'rebuilt' | 'unchanged' | 'skipped';

export interface CodegraphOutcome {
  status: CodegraphStatus;
  /** Skip cause, when status is `skipped` (one warning per cause per process). */
  reason?: string;
  files?: number;
  symbols?: number;
  edges?: number;
  /** Repo-relative files re-extracted. */
  changedFiles: number;
}

/** Causes already warned about in this process (specs/17: exactly one warning). */
const warned = new Set<string>();

/** Reset the warn-once set (tests). */
export function resetCodegraphWarnings(): void {
  warned.clear();
}

function warnOnce(repoId: string, cause: string): void {
  const key = `${repoId}: ${cause}`;
  if (warned.has(key)) return;
  warned.add(key);
  out.warn(`codegraph skipped for ${repoId}: ${cause}`);
}

/** Backend meta document (specs/17 "Storage"): remote, commit, counts, languages, generated-at. */
function metaYaml(graph: RepoGraph, now: Date, remote: string | undefined): string {
  const languages = [...new Set(graph.nodes.map((n) => n.language).filter((l) => l !== undefined))].sort();
  const meta: Record<string, unknown> = {
    codeCommit: graph.codeCommit,
    generated_at: now.toISOString(),
    counts: { files: graph.counts.files, symbols: graph.counts.symbols, edges: graph.counts.edges },
    languages,
  };
  if (remote !== undefined) meta.remote = remote;
  return YAML.stringify(meta) ?? '';
}

/** Cross-repo dependencies touching `repoId`: sibling repos whose modules it imports. */
export function crossRepoDeps(repoId: string, graphs: RepoGraph[], packages: Record<string, string | undefined>): CrossRepoDep[] {
  const all = crossRepoEdges(graphs, packages);
  const moduleRepoByNodeId = new Map<string, string>();
  for (const g of graphs) {
    for (const n of g.nodes) {
      if (n.kind === 'module' && n.manifest !== undefined) moduleRepoByNodeId.set(n.id, g.repoId);
    }
  }
  const deps: CrossRepoDep[] = [];
  for (const e of all.get(repoId) ?? []) {
    const target = moduleRepoByNodeId.get(e.target);
    if (target === undefined) continue;
    const source = graphs.find((g) => g.repoId === repoId)?.nodes.find((n) => n.id === e.source);
    if (!source) continue;
    deps.push({ repo: target, module: source.name });
  }
  deps.sort((a, b) => a.repo.localeCompare(b.repo) || a.module.localeCompare(b.module));
  return deps;
}

function hasGraphSupport(backend: BrainBackend): boolean {
  return typeof backend.saveGraph === 'function' && typeof backend.saveGraphMeta === 'function';
}

/**
 * Build or update the code graph of the repo at `repoRoot`, store it through
 * the backend, regenerate `index.md`, and recompute cross-repo edges.
 */
export async function runCodegraphStep(
  backend: BrainBackend,
  brain: BrainConfig,
  repoRoot: string | undefined,
  repoId: string,
  opts: { now?: Date; push?: boolean } = {},
): Promise<CodegraphOutcome> {
  const now = opts.now ?? new Date();
  const skip = (reason: string): CodegraphOutcome => {
    warnOnce(repoId, reason);
    return { status: 'skipped', reason, changedFiles: 0 };
  };
  // Running inside a brain clone (or `--brain` from outside): no code repo.
  if (repoRoot === undefined) return { status: 'skipped', changedFiles: 0 };
  if (!hasGraphSupport(backend)) return skip('this backend has no codegraph storage');

  let head: string | undefined;
  try {
    head = (await git.hasHead(repoRoot)) ? await git.headSha(repoRoot) : undefined;
  } catch {
    head = undefined;
  }
  if (head === undefined) return skip('the code repository has no commits');

  const stored = await backend.loadGraph(repoId);
  const meta = await backend.loadGraphMeta(repoId);
  const prev = stored !== undefined ? deserialize(stored) : undefined;
  // specs/17: a missing or unreadable meta means a full rebuild.
  const forceFull = prev === undefined || meta === undefined;

  try {
    const pkg = brain.repos.find((r) => r.id === repoId)?.package;
    const ownModule = moduleForRepo(repoRoot, typeof pkg === 'string' ? pkg : undefined);
    const { graph, changedFiles, rebuilt } = await updateGraph(repoRoot, prev, {
      repoId,
      ownModule,
      forceFull,
    });

    // Cross-repo edges are computed at brain level (specs/17), from every
    // sibling graph the backend holds. A repo's name is its `package:` field,
    // else the name its own manifest produced (kept in its graph's own module
    // node); neither means no edge, no warning.
    const graphs: RepoGraph[] = [];
    const graphByRepo = new Map<string, RepoGraph>();
    for (const r of brain.repos) {
      if (r.id === repoId) continue;
      const doc = await backend.loadGraph(r.id);
      const g = doc !== undefined ? deserialize(doc) : undefined;
      if (g !== undefined) {
        graphs.push(g);
        graphByRepo.set(r.id, g);
      }
    }
    graphs.push(graph);
    graphByRepo.set(repoId, graph);
    const packages: Record<string, string | undefined> = {};
    for (const r of brain.repos) {
      const g = graphByRepo.get(r.id);
      packages[r.id] = typeof r.package === 'string' ? r.package : g !== undefined ? ownModuleName(g) : undefined;
    }
    const crossEdges = crossRepoEdges(graphs, packages).get(repoId) ?? [];
    setCrossRepoEdges(graph, crossEdges);

    const doc = serialize(graph);
    if (stored === doc && !forceFull) {
      return { status: 'unchanged', files: graph.counts.files, symbols: graph.counts.symbols, edges: graph.counts.edges, changedFiles: 0 };
    }
    let remote: string | undefined;
    try {
      remote = await git.remoteUrl(repoRoot);
    } catch {
      remote = undefined;
    }
    await backend.saveGraph(repoId, doc);
    await backend.saveGraphMeta(repoId, metaYaml(graph, now, remote));
    await backend.write(graphIndexRelPath(repoId), renderGraphIndex(graph, crossRepoDeps(repoId, graphs, packages)));
    // The graph write lands after the sync's push (specs/03 order), so it is
    // settled as its own local revision and carried by the next push.
    try {
      if ((await backend.dirty()).length > 0) {
        await backend.commit(`codegraph: update graph for ${repoId}`);
        // Deliver the graph to the store in the same run, so a machine that
        // never syncs again still leaves the brain carrying its graph.
        if (opts.push && (await backend.remoteUrl()) !== undefined) {
          await backend.push({ paths: [], message: `codegraph: update graph for ${repoId}`, logEntries: [] });
        }
      }
    } catch {
      // Keeping the files uncommitted or unpushed is fine; the next sync
      // commits and pushes them.
    }
    return {
      // A rebuild past the 500-file threshold is reported as one too (specs/17),
      // not as an incremental "N files changed".
      status: rebuilt || forceFull ? 'rebuilt' : 'updated',
      files: graph.counts.files,
      symbols: graph.counts.symbols,
      edges: graph.counts.edges,
      changedFiles: changedFiles.length,
    };
  } catch (err) {
    return skip(err instanceof Error ? err.message : String(err));
  }
}

/** A sync/init report line for one outcome (specs/03 step 7, specs/02 step 8). */
export function describeOutcome(outcome: CodegraphOutcome | undefined): string | undefined {
  if (outcome === undefined || outcome.status === 'skipped') return undefined;
  if (outcome.status === 'unchanged') return undefined;
  if (outcome.status === 'rebuilt') return `codegraph: rebuilt (${outcome.changedFiles} files)`;
  return `codegraph: ${outcome.changedFiles} file${outcome.changedFiles === 1 ? '' : 's'} changed`;
}

/** Report row for `init`'s summary table. */
export function stepReportFor(repoId: string, outcome: CodegraphOutcome | undefined): StepReport {
  if (outcome === undefined || outcome.status === 'skipped') {
    const row: StepReport = { step: `codegraph ${repoId}`, state: 'skipped' };
    if (outcome?.reason !== undefined) row.detail = outcome.reason;
    return row;
  }
  if (outcome.status === 'unchanged') return { step: `codegraph ${repoId}`, state: 'up-to-date' };
  return {
    step: `codegraph ${repoId}`,
    state: 'done',
    detail: `${outcome.files ?? 0} files · ${outcome.symbols ?? 0} symbols · ${outcome.edges ?? 0} edges`,
  };
}