/**
 * Incremental graph update (specs/17 "When the graph is built"): diff the
 * stored `codeCommit` against the code repo's HEAD, re-extract only the files
 * whose content changed, splice, recompute. A full rebuild happens when there
 * is no previous graph, when its meta is unusable, or when the diff exceeds
 * 500 changed files.
 *
 * Every failure (git unavailable, grammar load, parse error) rejects with one
 * Error naming the cause; the caller prints exactly one warning and keeps the
 * stored graph — a broken graph never fails a sync.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as git from '../git.js';
import { extractFile, shaOf } from './extract.js';
import { applyOwnModule, buildGraph, dropFile, edgeId, fileNodeOf, nodeId, pruneEdges, recount, sortGraph, spliceFile } from './graph.js';
import { languageForPath, type CodeLanguage } from './languages.js';
import type { RepoGraph } from './graph.js';

/** specs/17: past this many changed files the whole graph is rebuilt. */
export const FULL_REBUILD_THRESHOLD = 500;

export interface OwnModule {
  name: string;
  manifest: string;
}

export interface UpdateOptions {
  repoId: string;
  /** The repo's own package name (brain.yml `package:`, else its manifest). */
  ownModule?: OwnModule;
  /** Force a full rebuild (used when the stored meta is missing/unreadable). */
  forceFull?: boolean;
}

export interface UpdateResult {
  graph: RepoGraph;
  /** Repo-relative paths that were re-extracted (all files on a full rebuild). */
  changedFiles: string[];
  rebuilt: boolean;
}

/** All files git knows about (tracked + untracked, .gitignore honoured). */
async function repoFiles(repoRoot: string): Promise<string[]> {
  const r = await git.git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot });
  const files: string[] = [];
  for (const p of r.stdout.split('\0')) {
    if (p.length === 0 || p === '.git' || p.startsWith('.git/')) continue;
    files.push(p.split(path.sep).join('/'));
  }
  return files;
}

async function readSource(repoRoot: string, rel: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(path.join(repoRoot, rel), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Changed paths between the stored commit and now: committed changes
 * (`stored..HEAD`) plus everything uncommitted (including untracked files).
 * Renames report both names — the old path's nodes are dropped and the new
 * one's spliced in (specs/17 "When the graph is built") — and the pairs are
 * carried separately so edges into the old file can follow the rename.
 */
async function changedPaths(repoRoot: string, stored: string): Promise<{ paths: string[]; renames: { from: string; to: string }[] }> {
  const paths = new Set<string>();
  const renames = new Map<string, string>();
  const consider = (e: git.StatusEntry): void => {
    paths.add(e.path);
    if (e.from === undefined) return;
    paths.add(e.from);
    if (e.code[0] === 'R') renames.set(e.from, e.path);
  };
  for (const e of await git.diffNameStatus(repoRoot, stored, 'HEAD')) consider(e);
  for (const e of await git.statusPorcelain(repoRoot)) consider(e);
  return {
    paths: [...paths].sort(),
    renames: [...renames.entries()].map(([from, to]) => ({ from, to })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
  };
}

/**
 * Edges that pointed at a renamed file's node follow the rename — the same
 * result a full rebuild produces. Runs before the old file's nodes are dropped,
 * so the edges survive the drop; anything still dangling afterwards (the new
 * path failed to materialise) is pruned at the end of the update.
 */
function retargetRenames(graph: RepoGraph, renames: { from: string; to: string }[]): void {
  for (const r of renames) {
    const fromId = nodeId(graph.repoId, 'file', r.from);
    const toId = nodeId(graph.repoId, 'file', r.to);
    for (const e of graph.edges) {
      if (e.target !== fromId) continue;
      e.target = toId;
      e.id = edgeId(graph.repoId, e.type, e.source, e.target);
    }
  }
}

/**
 * Update (or build) the graph of the code repo at `repoRoot`. `prev` is the
 * stored graph when there is one; `forceFull` replaces it (specs/17: full
 * rebuild past 500 changed files or when the meta is missing).
 */
export async function updateGraph(repoRoot: string, prev: RepoGraph | undefined, opts: UpdateOptions): Promise<UpdateResult> {
  const head = (await git.hasHead(repoRoot)) ? await git.headSha(repoRoot) : undefined;
  if (head === undefined) {
    throw new Error('codegraph: the code repository has no commits yet');
  }

  let changed: string[] = [];
  let renames: { from: string; to: string }[] = [];
  let rebuilt = prev === undefined || opts.forceFull;
  if (!rebuilt && prev !== undefined) {
    try {
      const diff = await changedPaths(repoRoot, prev.codeCommit);
      changed = diff.paths;
      renames = diff.renames;
    } catch (err) {
      // The stored commit is not in this repo's history (rewritten branch).
      throw new Error(`codegraph: stored commit is not in this repository's history: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    rebuilt = changed.length > FULL_REBUILD_THRESHOLD;
  }

  if (rebuilt) {
    const files: { path: string; source: string }[] = [];
    for (const rel of await repoFiles(repoRoot)) {
      const source = await readSource(repoRoot, rel);
      if (source === undefined) continue; // deleted in the index or on disk
      files.push({ path: rel, source });
    }
    const graph = await buildGraph(opts.repoId, head, files, { ownModule: opts.ownModule });
    return { graph, changedFiles: files.map((f) => f.path).sort(), rebuilt: true };
  }

  // Incremental: only the changed files are re-extracted; the rest keep their
  // nodes and edges (specs/17 "When the graph is built").
  const base = prev as RepoGraph;
  const graph: RepoGraph = {
    version: base.version,
    repoId: base.repoId,
    codeCommit: head,
    counts: { ...base.counts },
    nodes: base.nodes.map((n) => ({ ...n })),
    edges: base.edges.map((e) => ({ ...e })),
  };
  retargetRenames(graph, renames);
  for (const rel of changed) {
    const source = await readSource(repoRoot, rel);
    if (source === undefined) {
      dropFile(graph, rel);
      continue;
    }
    const language: CodeLanguage | undefined = languageForPath(rel);
    if (language === undefined) {
      // No grammar in v1: refresh the file node, no symbols or edges (specs/17).
      dropFile(graph, rel);
      graph.nodes.push(fileNodeOf(graph, rel, undefined, shaOf(source)));
      continue;
    }
    const extraction = await extractFile(rel, language, source);
    spliceFile(graph, extraction, opts.ownModule);
  }
  applyOwnModule(graph, opts.ownModule);
  // A retargeted rename edge dangles when the new path never materialised.
  pruneEdges(graph);
  sortGraph(graph);
  recount(graph);
  return { graph, changedFiles: changed, rebuilt: false };
}
