/**
 * RepoGraph schema and determinism (specs/17): canonical ordering, stable ids,
 * byte-identical serialisation for the same tree, and the splice/drop
 * primitives the incremental update uses.
 */
import { describe, expect, it } from 'vitest';
import { extractFile } from '../../src/codegraph/extract.js';
import {
  buildGraph,
  crossRepoEdges,
  deserialize,
  dropFile,
  nodeId,
  serialize,
  sortGraph,
  spliceFile,
  type RepoGraph,
} from '../../src/codegraph/graph.js';

const greet = [
  "import { pad } from './pad';",
  "import { Client } from '@acme/payments-api';",
  'export function greet(name: string): string {',
  "  return pad('hello ' + name);",
  '}',
].join('\n');
const padSource = ['export function pad(s: string): string {', "  return ' ' + s;", '}'].join('\n');

describe('node ids', () => {
  it('are stable hashes of repo id + kind + identity', () => {
    expect(nodeId('r', 'file', 'src/a.ts')).toBe(nodeId('r', 'file', 'src/a.ts'));
    expect(nodeId('r', 'file', 'src/a.ts')).not.toBe(nodeId('r2', 'file', 'src/a.ts'));
    expect(nodeId('r', 'file', 'src/a.ts')).not.toBe(nodeId('r', 'symbol', 'src/a.ts'));
  });
});

describe('buildGraph', () => {
  it('creates file, symbol and module nodes with contains/imports edges', async () => {
    const graph = await buildGraphFixture();
    expect(byKindNodes(graph, 'file')).toEqual(['src/greet.ts', 'src/pad.ts']);
    expect(byKindNodes(graph, 'symbol')).toEqual(['greet', 'pad']);
    expect(byKindNodes(graph, 'module')).toEqual(['@acme/payments-api']);
    // Without a known own package, module nodes exist only for what is imported.
    expect(edgePairs(graph, 'contains')).toEqual([
      ['src/greet.ts', 'greet'],
      ['src/pad.ts', 'pad'],
    ]);
    expect(edgePairs(graph, 'imports').length).toBe(2);
    expect(edgePairs(graph, 'imports')).toEqual([
      ['src/greet.ts', '@acme/payments-api'],
      ['src/greet.ts', 'src/pad.ts'],
    ]);
    // greet calls pad across files: intra-file resolution makes no edge (specs/17).
    expect(edgePairs(graph, 'calls')).toEqual([]);
  });

  it('recounts the denormalised counts', async () => {
    const graph = await buildGraphFixture();
    expect(graph.counts).toEqual({ files: 2, symbols: 2, edges: 4 });
  });

  it('file nodes carry the content sha and the commit', async () => {
    const graph = await buildGraphFixture();
    const greet = graph.nodes.find((n) => n.kind === 'file' && n.name === 'src/greet.ts')!;
    expect(greet.codeCommit).toBe('c');
    expect(greet.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(greet.language).toBe('ts');
  });

  it('round-trips through serialize/deserialize', async () => {
    const graph = await buildGraphFixture();
    const doc = serialize(graph);
    expect(deserialize(doc)).toEqual(graph);
    expect(deserialize('not json')).toBeUndefined();
    expect(deserialize('{"version":99}')).toBeUndefined();
  });

  it('a node: builtin makes no module node and no imports edge', async () => {
    const graph = await buildGraph('r', 'c', [
      { path: 'src/fs.ts', source: "import { readFileSync } from 'node:fs';\nexport function read(p: string): string { return readFileSync(p, 'utf8'); }\n" },
    ]);
    expect(byKindNodes(graph, 'module')).toEqual([]);
    expect(edgePairs(graph, 'imports')).toEqual([]);
    expect(graph.counts).toEqual({ files: 1, symbols: 1, edges: 1 });
  });

  it('a bare subpath import lands on its package module node', async () => {
    const graph = await buildGraph('r', 'c', [
      { path: 'src/greet.ts', source: greet },
      { path: 'src/pad.ts', source: padSource },
      { path: 'src/deep.ts', source: "import { helper } from '@acme/payments-api/client';\nexport function deep(): string { return helper(); }\n" },
    ]);
    // `@acme/payments-api/client` matches the `@acme/payments-api` module node.
    expect(byKindNodes(graph, 'module')).toEqual(['@acme/payments-api']);
    expect(edgePairs(graph, 'imports')).toEqual([
      ['src/deep.ts', '@acme/payments-api'],
      ['src/greet.ts', '@acme/payments-api'],
      ['src/greet.ts', 'src/pad.ts'],
    ]);
  });
});

describe('determinism', () => {
  it('serialises byte-identically for the same tree at the same commit', async () => {
    const a = await buildGraphFixture();
    const b = await buildGraphFixture();
    expect(serialize(a)).toBe(serialize(b));
    // ...and the document carries no timestamp (that lives in the meta).
    expect(serialize(a)).not.toMatch(/generated|timestamp/i);
  });

  it('sorts nodes and edges canonically', async () => {
    const graph = await buildGraphFixture();
    const doc = serialize(graph);
    graph.nodes.reverse();
    graph.edges.reverse();
    sortGraph(graph);
    expect(serialize(graph)).toBe(doc);
  });
});

describe('splice / drop', () => {
  it('replaces only the spliced file; other nodes and edges survive untouched', async () => {
    const graph = await buildGraphFixture();
    const padNode = graph.nodes.find((n) => n.kind === 'symbol' && n.name === 'pad');

    const extraction = await extractFile('src/greet.ts', 'ts', [
      "import { pad } from './pad';",
      'export function greet(name: string): string {',
      '  return pad(name);',
      '}',
    ].join('\n'));
    spliceFile(graph, extraction, undefined);

    expect(graph.nodes.find((n) => n.kind === 'symbol' && n.name === 'pad')).toEqual(padNode);
    // The file node, its symbol and both imports edges are rebuilt; nothing else moved.
    expect(graph.counts).toEqual({ files: 2, symbols: 2, edges: 3 });
    expect(edgePairs(graph, 'imports')).toEqual([['src/greet.ts', 'src/pad.ts']]);
  });

  it('dropFile removes the file node, its symbols and every edge touching them', async () => {
    const graph = await buildGraphFixture();
    dropFile(graph, 'src/pad.ts');
    expect(byKindNodes(graph, 'file')).toEqual(['src/greet.ts']);
    expect(graph.counts).toEqual({ files: 1, symbols: 1, edges: 2 });
  });
});

describe('crossRepoEdges', () => {
  it('matches module nodes against sibling package names; no name means no edge', async () => {
    const a = await buildGraph('orders-service', 'c0', [{ path: 'src/index.ts', source: greet }]);
    const b = await buildGraph('payments-api', 'c0', [{ path: 'src/client.ts', source: padSource }], {
      ownModule: { name: '@acme/payments-api', manifest: 'package.json' },
    });

    // Without a package name for the sibling: no edge, no warning.
    expect([...crossRepoEdges([a, b], {}).get('orders-service') ?? []]).toEqual([]);
    // With the package name matched: one imports_repo edge into the sibling's module.
    const edges = crossRepoEdges([a, b], { 'payments-api': '@acme/payments-api' }).get('orders-service') ?? [];
    expect(edges).toHaveLength(1);
    const target = b.nodes.find((n) => n.kind === 'module' && n.name === '@acme/payments-api');
    expect(edges[0]).toMatchObject({ type: 'imports_repo', target: target!.id });
  });
});

// ---- helpers ---------------------------------------------------------------

function byKindNodes(graph: RepoGraph, kind: string): string[] {
  return graph.nodes.filter((n) => n.kind === kind).map((n) => n.name).sort();
}

function edgePairs(graph: RepoGraph, type: string): [string, string][] {
  const nameOf = (id: string): string => graph.nodes.find((n) => n.id === id)?.name ?? '??';
  return graph.edges
    .filter((e) => e.type === type)
    .map((e) => [nameOf(e.source), nameOf(e.target)] as [string, string])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

function buildGraphFixture(): Promise<RepoGraph> {
  return buildGraph('r', 'c', [
    { path: 'src/greet.ts', source: greet },
    { path: 'src/pad.ts', source: padSource },
  ]);
}
