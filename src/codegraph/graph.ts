/**
 * The RepoGraph (specs/17 "RepoGraph schema"): nodes (file | symbol | module),
 * edges (contains | imports | calls | imports_repo), canonical ordering and
 * serialisation, plus the merge/diff primitives the incremental update needs.
 *
 * Determinism: ids are hashes of repo id + kind + identity, lists are sorted
 * canonically, and the serialised document carries no timestamp — the same
 * tree at the same commit serialises byte-identically (specs/17 acceptance).
 * `generatedAt` is graph metadata (meta.yml), never part of the document.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CodeLanguage } from './languages.js';
import { languageForPath } from './languages.js';
import { extractFile, isBuiltinSpec, packageNameOf, shaOf, type FileExtraction, type SymbolKind } from './extract.js';

export const GRAPH_VERSION = 1;

export type GraphNodeKind = 'file' | 'symbol' | 'module';
export type GraphEdgeType = 'contains' | 'imports' | 'calls' | 'imports_repo';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** file: repo-relative path · symbol: qualified name · module: package name. */
  name: string;
  /** file nodes: the repo-relative path; symbol nodes: the file they sit in. */
  path?: string;
  language?: CodeLanguage;
  /** file nodes: sha256 of the content the node was extracted from. */
  sha?: string;
  /** symbol nodes: function | class | method | type | const. */
  symbolKind?: SymbolKind;
  /** symbol nodes: 1-based line range in the file. */
  line?: number;
  endLine?: number;
  /** module nodes: the manifest the name came from, when one exists. */
  manifest?: string;
  codeCommit: string;
}

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  source: string;
  target: string;
  codeCommit: string;
}

export interface GraphCounts {
  files: number;
  symbols: number;
  edges: number;
}

export interface RepoGraph {
  version: number;
  repoId: string;
  /** Commit the graph was extracted from (specs/17: staleness without re-parsing). */
  codeCommit: string;
  counts: GraphCounts;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const KIND_RANK: Record<GraphNodeKind, number> = { file: 0, module: 1, symbol: 2 };
const EDGE_RANK: Record<GraphEdgeType, number> = { contains: 0, imports: 1, calls: 2, imports_repo: 3 };
const IMPORT_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.py'] as const;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable node id: hash of repo id + kind + canonical identity (specs/17). */
export function nodeId(repoId: string, kind: GraphNodeKind, identity: string): string {
  return createHash('sha256').update(`${repoId} ${kind} ${identity}`, 'utf8').digest('hex');
}

export function edgeId(repoId: string, type: GraphEdgeType, source: string, target: string): string {
  return createHash('sha256').update(`${repoId} ${type} ${source} ${target}`, 'utf8').digest('hex');
}

export function emptyGraph(repoId: string, codeCommit: string): RepoGraph {
  return { version: GRAPH_VERSION, repoId, codeCommit, counts: { files: 0, symbols: 0, edges: 0 }, nodes: [], edges: [] };
}

/** Canonical order: files, modules, symbols (by path then name); edges by type, source, target. */
export function sortGraph(graph: RepoGraph): void {
  graph.nodes.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || cmp(a.path ?? '', b.path ?? '') || cmp(a.name, b.name) || cmp(a.id, b.id));
  graph.edges.sort((a, b) => EDGE_RANK[a.type] - EDGE_RANK[b.type] || cmp(a.source, b.source) || cmp(a.target, b.target) || cmp(a.id, b.id));
}

/** Recompute the denormalised counts (specs/17). */
export function recount(graph: RepoGraph): void {
  let files = 0;
  let symbols = 0;
  for (const n of graph.nodes) {
    if (n.kind === 'file') files += 1;
    else if (n.kind === 'symbol') symbols += 1;
  }
  graph.counts = { files, symbols, edges: graph.edges.length };
}

/**
 * The repo's own package name: `brain.yml` `package:` wins, then the repo's
 * manifest (package.json / Cargo.toml / pyproject.toml / go.mod), then nothing.
 * specs/17 "Cross-repo edges": a missing name means no module node and no edge.
 */
export function moduleForRepo(repoRoot: string, brainPackage: string | undefined): { name: string; manifest: string } | undefined {
  if (brainPackage !== undefined && brainPackage.trim().length > 0) {
    return { name: brainPackage.trim(), manifest: 'brain.yml' };
  }
  const manifests: { file: string; read: (text: string) => string | undefined }[] = [
    {
      file: 'package.json',
      read: (text) => {
        try {
          const name = (JSON.parse(text) as { name?: unknown })?.name;
          return typeof name === 'string' && name.length > 0 ? name : undefined;
        } catch {
          return undefined;
        }
      },
    },
    { file: 'Cargo.toml', read: (text) => /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] },
    { file: 'pyproject.toml', read: (text) => /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] },
    { file: 'go.mod', read: (text) => /^module\s+(\S+)/m.exec(text)?.[1] },
  ];
  for (const m of manifests) {
    try {
      const name = m.read(fs.readFileSync(path.join(repoRoot, m.file), 'utf8'));
      if (name) return { name, manifest: m.file };
    } catch {
      // no such manifest; try the next one
    }
  }
  return undefined;
}

/**
 * The repo's own package name as recorded in its graph, when it came from a
 * real manifest (package.json / Cargo.toml / pyproject.toml / go.mod).
 * specs/17 "Cross-repo edges": a manifest name is a fallback for a missing
 * `package:` field. A node whose manifest is `brain.yml` carries the `package:`
 * field itself, which the caller has already consulted — never a fallback.
 */
export function ownModuleName(graph: RepoGraph): string | undefined {
  return graph.nodes.find((n) => n.kind === 'module' && n.manifest !== undefined && n.manifest !== 'brain.yml')?.name;
}

export function fileNodeOf(graph: RepoGraph, filePath: string, language: CodeLanguage | undefined, sha: string | undefined): GraphNode {
  const node: GraphNode = {
    id: nodeId(graph.repoId, 'file', filePath),
    kind: 'file',
    name: filePath,
    path: filePath,
    codeCommit: graph.codeCommit,
  };
  if (language !== undefined) node.language = language;
  if (sha !== undefined) node.sha = sha;
  return node;
}

function symbolNodeOf(graph: RepoGraph, filePath: string, s: FileExtraction['symbols'][number]): GraphNode {
  return {
    id: nodeId(graph.repoId, 'symbol', `${filePath} ${s.name}`),
    kind: 'symbol',
    name: s.name,
    path: filePath,
    symbolKind: s.kind,
    line: s.line,
    endLine: s.endLine,
    codeCommit: graph.codeCommit,
  };
}

/**
 * Drop every node and edge that belongs to `file` — the file node, the symbols
 * it contains, and the edges leaving either (the diff step of the incremental
 * update, specs/17 "When the graph is built"). With `deleted` the file is gone
 * from the repo, so edges pointing into it from other files go too; a re-splice
 * keeps them (the node ids are rebuilt identically) and dangling ones are
 * pruned afterwards.
 */
export function dropFile(graph: RepoGraph, file: string, opts: { keepIncoming?: boolean } = {}): void {
  const doomed = new Set<string>();
  for (const n of graph.nodes) {
    if ((n.kind === 'file' || n.kind === 'symbol') && n.path === file) doomed.add(n.id);
  }
  if (doomed.size === 0) return;
  graph.nodes = graph.nodes.filter((n) => !doomed.has(n.id));
  graph.edges = graph.edges.filter((e) => {
    if (doomed.has(e.source)) return false;
    if (opts.keepIncoming !== true && doomed.has(e.target)) return false;
    return true;
  });
  recount(graph);
}

/** Remove edges whose endpoints no longer exist. */
export function pruneEdges(graph: RepoGraph): void {
  const ids = new Set(graph.nodes.map((n) => n.id));
  graph.edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
}

/** Keep the repo's own module node in step with its package name. */
function ensureOwnModule(graph: RepoGraph, ownModule: { name: string; manifest: string } | undefined): GraphNode | undefined {
  // A module node carrying a manifest is the repo's own; a `package:` change
  // renames it, so drop the old one (its contains edges go with it).
  const removed = new Set(
    graph.nodes.filter((n) => n.kind === 'module' && n.manifest !== undefined && (ownModule === undefined || n.name !== ownModule.name || n.manifest !== ownModule.manifest)).map((n) => n.id),
  );
  if (removed.size > 0) {
    graph.nodes = graph.nodes.filter((n) => !removed.has(n.id));
    graph.edges = graph.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target));
  }
  if (ownModule === undefined) return undefined;
  const existing = graph.nodes.find((n) => n.kind === 'module' && n.name === ownModule.name);
  if (existing) {
    existing.manifest = ownModule.manifest;
    existing.codeCommit = graph.codeCommit;
    return existing;
  }
  const node: GraphNode = { id: nodeId(graph.repoId, 'module', ownModule.name), kind: 'module', name: ownModule.name, manifest: ownModule.manifest, codeCommit: graph.codeCommit };
  graph.nodes.push(node);
  return node;
}

function ensureModuleNode(graph: RepoGraph, name: string): GraphNode {
  const existing = graph.nodes.find((n) => n.kind === 'module' && n.name === name && n.manifest === undefined);
  if (existing) return existing;
  const node: GraphNode = { id: nodeId(graph.repoId, 'module', name), kind: 'module', name, codeCommit: graph.codeCommit };
  graph.nodes.push(node);
  return node;
}

/**
 * Resolve one import to a target node id, or undefined when it resolves to
 * nothing (a relative spec matching no file of the repo, or a `node:` builtin —
 * no module node, no edge, no warning; specs/17: builtins are imports, not
 * modules). A bare specifier matches its package, so `@acme/pkg/client` lands
 * on the `@acme/pkg` module node.
 */
export function resolveImport(graph: RepoGraph, importingFile: string, spec: string, kind: 'relative' | 'bare'): string | undefined {
  if (kind === 'bare') {
    if (isBuiltinSpec(spec)) return undefined;
    return ensureModuleNode(graph, packageNameOf(spec)).id;
  }
  const dir = path.posix.dirname(importingFile);
  const joined = path.posix.normalize(path.posix.join(dir, spec));
  const files = new Set(graph.nodes.filter((n) => n.kind === 'file').map((n) => n.path ?? ''));
  for (const ext of IMPORT_EXTS) {
    if (files.has(joined + ext)) return nodeId(graph.repoId, 'file', joined + ext);
  }
  for (const ext of IMPORT_EXTS) {
    if (ext === '') continue;
    const idx = path.posix.join(joined, 'index' + ext);
    if (files.has(idx)) return nodeId(graph.repoId, 'file', idx);
  }
  return undefined;
}

/**
 * Make sure the repo's own module node exists and contains every file node —
 * called on the incremental path too, where a `package:` added to `brain.yml`
 * (or a manifest) must materialise even when no source file changed.
 */
export function applyOwnModule(graph: RepoGraph, ownModule: { name: string; manifest: string } | undefined): void {
  const own = ensureOwnModule(graph, ownModule);
  if (!own) return;
  for (const n of graph.nodes) {
    if (n.kind !== 'file') continue;
    if (graph.edges.some((e) => e.type === 'contains' && e.source === own.id && e.target === n.id)) continue;
    graph.edges.push({ id: edgeId(graph.repoId, 'contains', own.id, n.id), type: 'contains', source: own.id, target: n.id, codeCommit: graph.codeCommit });
  }
}

/**
 * Splice one freshly extracted file into the graph: its previous nodes and
 * edges are dropped, then the new ones are added (specs/17 "When the graph
 * is built"). `ownModule` supplies the module→file contains edge.
 */
export function spliceFile(graph: RepoGraph, extraction: FileExtraction, ownModule: { name: string; manifest: string } | undefined): void {
  // Incoming edges from unchanged files survive the splice when their target
  // survives too (the node ids are rebuilt identically); dangling ones — a
  // symbol that no longer exists — are pruned at the end.
  dropFile(graph, extraction.path, { keepIncoming: true });
  const commit = graph.codeCommit;
  const own = ensureOwnModule(graph, ownModule);
  const filePath = extraction.path;
  graph.nodes.push(fileNodeOf(graph, filePath, extraction.language, extraction.sha));
  for (const s of extraction.symbols) graph.nodes.push(symbolNodeOf(graph, filePath, s));

  const symbolId = (name: string): string | undefined =>
    graph.nodes.find((n) => n.kind === 'symbol' && n.path === filePath && n.name === name)?.id;
  const fileId = nodeId(graph.repoId, 'file', filePath);
  const pushEdge = (type: GraphEdgeType, source: string, target: string): void => {
    graph.edges.push({ id: edgeId(graph.repoId, type, source, target), type, source, target, codeCommit: commit });
  };

  // The module→file contains edge usually exists already (buildGraph adds it
  // for every file up front; on the incremental path it survived dropFile's
  // keepIncoming): only add it when it is genuinely missing, or every splice
  // would duplicate it and inflate the edge count.
  if (own && !graph.edges.some((e) => e.type === 'contains' && e.source === own.id && e.target === fileId)) {
    pushEdge('contains', own.id, fileId);
  }
  for (const s of extraction.symbols) {
    const id = symbolId(s.name);
    if (id) pushEdge('contains', fileId, id);
  }
  for (const imp of extraction.imports) {
    const target = resolveImport(graph, filePath, imp.spec, imp.kind);
    if (target !== undefined) pushEdge('imports', fileId, target);
  }
  for (const c of extraction.calls) {
    const source = symbolId(c.caller);
    const target = symbolId(c.callee);
    if (source && target) pushEdge('calls', source, target);
  }
  pruneEdges(graph);
  sortGraph(graph);
  recount(graph);
}

/**
 * Full build from repo files (specs/17: full rebuild past 500 changed files or
 * when the stored meta is missing). Files without a v1 grammar become bare
 * file nodes; supported files are extracted here.
 */
export async function buildGraph(
  repoId: string,
  codeCommit: string,
  files: { path: string; source: string }[],
  opts: { ownModule?: { name: string; manifest: string }; now?: Date } = {},
): Promise<RepoGraph> {
  const graph = emptyGraph(repoId, codeCommit);
  // File nodes first, so relative imports can resolve against the whole repo.
  for (const f of files) {
    const filePath = f.path.split('\\').join('/');
    graph.nodes.push(fileNodeOf(graph, filePath, languageForPath(filePath), shaOf(f.source)));
  }
  applyOwnModule(graph, opts.ownModule);
  for (const f of files) {
    const language = languageForPath(f.path);
    if (language === undefined) continue; // file node only (specs/17)
    const extraction = await extractFile(f.path, language, f.source);
    spliceFile(graph, extraction, opts.ownModule);
  }
  graph.codeCommit = codeCommit;
  sortGraph(graph);
  recount(graph);
  return graph;
}

/** Replace the imports_repo edges of one repo (recomputed at brain level). */
export function setCrossRepoEdges(graph: RepoGraph, edges: GraphEdge[]): void {
  graph.edges = graph.edges.filter((e) => e.type !== 'imports_repo');
  for (const e of edges) graph.edges.push(e);
  sortGraph(graph);
  recount(graph);
}

/**
 * Cross-repo edges (specs/17 "Cross-repo edges"): a repo's module nodes are
 * matched against sibling repos' package names. `packages` maps repo id → the
 * `package` field of `brain.yml` (or a manifest-derived name); a sibling with
 * no name makes no edge — no warning, no error.
 *
 * Returns, per repo id, the imports_repo edges that repo's graph carries.
 */
export function crossRepoEdges(graphs: RepoGraph[], packages: Record<string, string | undefined>): Map<string, GraphEdge[]> {
  const byRepo = new Map<string, RepoGraph>();
  for (const g of graphs) if (!byRepo.has(g.repoId)) byRepo.set(g.repoId, g);
  const out = new Map<string, GraphEdge[]>();
  const repoIds = [...byRepo.keys()].sort();
  for (const repoId of repoIds) {
    const graph = byRepo.get(repoId)!;
    const edges: GraphEdge[] = [];
    for (const module of graph.nodes.filter((n) => n.kind === 'module')) {
      for (const siblingId of repoIds) {
        if (siblingId === repoId) continue;
        const pkg = packages[siblingId];
        if (pkg === undefined || pkg !== module.name) continue;
        const target = byRepo.get(siblingId)!.nodes.find((n) => n.kind === 'module' && n.name === pkg);
        if (!target) continue;
        edges.push({ id: edgeId(repoId, 'imports_repo', module.id, target.id), type: 'imports_repo', source: module.id, target: target.id, codeCommit: graph.codeCommit });
      }
    }
    edges.sort((a, b) => cmp(a.source, b.source) || cmp(a.target, b.target));
    out.set(repoId, edges);
  }
  return out;
}

/** Serialise byte-identically for the same tree at the same commit. */
export function serialize(graph: RepoGraph): string {
  const doc = {
    version: graph.version,
    repoId: graph.repoId,
    codeCommit: graph.codeCommit,
    counts: graph.counts,
    nodes: graph.nodes,
    edges: graph.edges,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Parse a stored document; any problem yields undefined (fail soft). */
export function deserialize(text: string): RepoGraph | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof doc !== 'object' || doc === null) return undefined;
  const d = doc as Record<string, unknown>;
  if (d.version !== GRAPH_VERSION) return undefined;
  if (typeof d.repoId !== 'string' || typeof d.codeCommit !== 'string') return undefined;
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) return undefined;
  const graph: RepoGraph = {
    version: GRAPH_VERSION,
    repoId: d.repoId,
    codeCommit: d.codeCommit,
    counts: { files: 0, symbols: 0, edges: 0 },
    nodes: d.nodes as GraphNode[],
    edges: d.edges as GraphEdge[],
  };
  if (typeof d.counts === 'object' && d.counts !== null) {
    const c = d.counts as Record<string, unknown>;
    if (typeof c.files === 'number') graph.counts.files = c.files;
    if (typeof c.symbols === 'number') graph.counts.symbols = c.symbols;
    if (typeof c.edges === 'number') graph.counts.edges = c.edges;
  }
  return graph;
}
