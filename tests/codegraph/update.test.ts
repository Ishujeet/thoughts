/**
 * The incremental update (specs/17 "When the graph is built"): only changed
 * files are re-extracted, counts follow, and the >500-files threshold (or a
 * missing previous graph) forces a full rebuild.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as git from '../../src/git.js';
import { FULL_REBUILD_THRESHOLD, updateGraph } from '../../src/codegraph/update.js';
import { nodeId, serialize, type RepoGraph } from '../../src/codegraph/graph.js';

let repo: string;

beforeEach(async () => {
  repo = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codegraph-update-')));
  await git.init(repo);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.ts'), "import { b } from './b';\nexport function a(): string { return b(); }\n");
  fs.writeFileSync(path.join(repo, 'src/b.ts'), 'export function b(): string {\n  return "b";\n}\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
  await git.addAll(repo);
  await git.commit(repo, 'initial');
});

afterEach(async () => {
  await fs.promises.rm(repo, { recursive: true, force: true });
});

describe('updateGraph', () => {
  it('builds fully when there is no previous graph', async () => {
    const r = await updateGraph(repo, undefined, { repoId: 'svc' });
    expect(r.rebuilt).toBe(true);
    expect(r.graph.counts).toEqual({ files: 3, symbols: 2, edges: 3 });
    expect(r.changedFiles).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
  });

  it('re-extracts only the file that changed and keeps the rest byte-stable', async () => {
    const first = await updateGraph(repo, undefined, { repoId: 'svc' });
    const untouched = serialize(first.graph);

    fs.writeFileSync(path.join(repo, 'src/a.ts'), "import { b } from './b';\nexport function a(): string { return b() + '!'; }\n");
    const second = await updateGraph(repo, first.graph, { repoId: 'svc' });

    expect(second.rebuilt).toBe(false);
    expect(second.changedFiles).toEqual(['src/a.ts']);
    expect(second.graph.counts).toEqual(first.graph.counts);
    // Unchanged files keep their nodes and edges (specs/17).
    const before = JSON.parse(untouched) as RepoGraph;
    const keep = (g: RepoGraph) => g.nodes.filter((n) => n.path === 'src/b.ts').sort((x, y) => x.id.localeCompare(y.id));
    expect(keep(second.graph)).toEqual(keep(before));
    // ...and the stored commit moves to HEAD.
    expect(second.graph.codeCommit).toBe(await git.headSha(repo));
  });

  it('drops the nodes of a deleted file', async () => {
    const first = await updateGraph(repo, undefined, { repoId: 'svc' });
    fs.rmSync(path.join(repo, 'src/b.ts'));
    const second = await updateGraph(repo, first.graph, { repoId: 'svc' });
    expect(second.changedFiles).toEqual(['src/b.ts']);
    expect(second.graph.nodes.filter((n) => n.path === 'src/b.ts')).toEqual([]);
  });

  it('a git mv replaces the old file with the renamed one', async () => {
    const first = await updateGraph(repo, undefined, { repoId: 'svc' });
    expect(first.graph.nodes.some((n) => n.path === 'src/b.ts')).toBe(true);

    await git.git(['mv', 'src/b.ts', 'src/c.ts'], { cwd: repo });
    await git.addAll(repo);
    await git.commit(repo, 'rename');

    const second = await updateGraph(repo, first.graph, { repoId: 'svc' });
    expect(second.rebuilt).toBe(false);
    // Both names enter the change set: the old file's nodes are dropped, the
    // new one's spliced in (specs/17 "When the graph is built").
    expect(second.changedFiles).toEqual(['src/b.ts', 'src/c.ts']);
    expect(second.graph.nodes.filter((n) => n.path === 'src/b.ts')).toEqual([]);
    expect(second.graph.nodes.some((n) => n.kind === 'file' && n.path === 'src/c.ts')).toBe(true);
    expect(second.graph.nodes.some((n) => n.kind === 'symbol' && n.name === 'b' && n.path === 'src/c.ts')).toBe(true);
    // a.ts's import of './b' now points at the renamed file; the count is right.
    expect(second.graph.counts.files).toBe(3);
    expect(second.graph.counts.symbols).toBe(2);
    expect(second.graph.edges.some((e) => e.type === 'imports' && e.target === nodeId('svc', 'file', 'src/c.ts'))).toBe(true);
  });

  it('rebuilds fully past the 500 changed files threshold', async () => {
    const first = await updateGraph(repo, undefined, { repoId: 'svc' });
    fs.mkdirSync(path.join(repo, 'gen'), { recursive: true });
    for (let i = 0; i < FULL_REBUILD_THRESHOLD + 1; i += 1) {
      fs.writeFileSync(path.join(repo, `gen/f${i}.txt`), `file ${i}\n`);
    }
    const second = await updateGraph(repo, first.graph, { repoId: 'svc' });
    expect(second.rebuilt).toBe(true);
    expect(second.changedFiles.length).toBeGreaterThanOrEqual(FULL_REBUILD_THRESHOLD + 1);
  });

  it('rejects with one error when the repo has no commits', async () => {
    const empty = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codegraph-empty-')));
    try {
      await git.init(empty);
      await expect(updateGraph(empty, undefined, { repoId: 'svc' })).rejects.toThrow(/no commits/);
    } finally {
      await fs.promises.rm(empty, { recursive: true, force: true });
    }
  });
});
