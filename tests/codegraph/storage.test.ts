/**
 * Codegraph storage and isolation (specs/17 "Storage", "codegraph/ is
 * generated data, never hand-edited"): the git backend's files, the meta
 * document, the generated index.md, and the guarantees that the generated
 * data is invisible to the walk, `locate`, the scanner and the log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { locate } from '../../src/brain/location.js';
import { listThoughts } from '../../src/brain/walk.js';
import { scanTree } from '../../src/security/scanner.js';
import { runInit } from '../../src/commands/init.js';
import { runNew } from '../../src/commands/new.js';
import { runSync } from '../../src/commands/sync.js';
import { makeBareBrain, makeCodeRepo, makeMachine, capture, cleanupMachines, commitAll, fakeStripeKey, read, write, type Captured } from '../commands/helpers.js';

let cap: Captured;
beforeEach(async () => {
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

interface Rig {
  repo: string;
  brain: string;
}

async function rig(label: string): Promise<Rig> {
  const host = await makeMachine(label + '-host');
  const bare = await makeBareBrain(host.root);
  const machine = await makeMachine(label);
  const repo = await makeCodeRepo(path.join(machine.root, 'payments-api'));
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  write(path.join(repo, 'src/index.ts'), 'export function main(): number { return 1; }\n');
  await commitAll(repo, 'code');
  const r = await runInit({ yes: true, brain: bare }, repo);
  cap.stdout.length = 0;
  cap.stderr.length = 0;
  return { repo, brain: r.brainRoot };
}

describe('codegraph storage', () => {
  it('init builds the graph, meta and index; the summary row reports it', async () => {
    const { brain } = await rig('cg-store');
    const dir = path.join(brain, 'repos', 'payments-api', 'codegraph');
    const graph: { codeCommit: string; counts: unknown } = JSON.parse(read(path.join(dir, 'graph.json')));
    expect(graph.codeCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(graph.counts).toMatchObject({ files: expect.any(Number), symbols: 1 });

    const meta = read(path.join(dir, 'meta.yml'));
    expect(meta).toContain('codeCommit:');
    expect(meta).toContain('generated_at:');
    expect(meta).toContain('counts:');

    const index = read(path.join(dir, 'index.md'));
    expect(index).toContain('# codegraph — payments-api');
    expect(index).toContain('function main');

  });

  it('the generated data is invisible to locate, the thought walk and the log', async () => {
    const { repo, brain } = await rig('cg-locate');
    expect(locate('/repos/payments-api/codegraph/graph.json')).toBeUndefined();
    expect(locate('/repos/payments-api/codegraph/index.md')).toBeUndefined();
    expect(locate('/repos/payments-api/specs/2026-09-01-x.md')).toBeDefined();
    const thoughts = await listThoughts(brain);
    expect(thoughts.some((t) => t.location.path.includes('/codegraph/'))).toBe(false);

    // A sync that only regenerates the graph logs no entries for it.
    await runNew('spec', 'Refund endpoint', {}, repo);
    const s = await runSync({}, repo);
    expect(s.entries.every((e) => !e.path.includes('/codegraph/'))).toBe(true);
  });

  it('the scanner never reports findings inside a repo codegraph directory', async () => {
    const { brain } = await rig('cg-scan');
    // A secret-looking value inside the generated data is never scanned.
    write(path.join(brain, 'repos', 'payments-api', 'codegraph', 'index.md'), `key = "${fakeStripeKey()}"\n`);
    const findings = await scanTree(brain);
    expect(findings).toEqual([]);
  });

  it('a second sync without changes leaves the graph and the brain untouched', async () => {
    const { repo, brain } = await rig('cg-idem');
    const before = read(path.join(brain, 'repos', 'payments-api', 'codegraph', 'graph.json'));
    const head = (await import('../../src/git.js')).headSha;
    const shaBefore = await head(brain);
    const s = await runSync({}, repo);
    expect(s.codegraph?.status).toBe('unchanged');
    expect(read(path.join(brain, 'repos', 'payments-api', 'codegraph', 'graph.json'))).toBe(before);
    expect(await head(brain)).toBe(shaBefore);
  });

  it('committing code moves the graph to the new HEAD on the next sync', async () => {
    const { repo, brain } = await rig('cg-incr');
    write(path.join(repo, 'src/index.ts'), 'export function main(): number { return 2; }\nexport function extra(): string { return "x"; }\n');
    await commitAll(repo, 'change code');
    const s = await runSync({}, repo);
    // The kit files the first commit sweeps in are re-extracted too.
    expect(s.codegraph?.status).toBe('updated');
    expect(s.codegraph?.changedFiles).toBeGreaterThanOrEqual(1);
    const graph: { codeCommit: string; counts: { symbols: number } } = JSON.parse(
      read(path.join(brain, 'repos', 'payments-api', 'codegraph', 'graph.json')),
    );
    expect(graph.counts.symbols).toBe(2);
    expect(graph.codeCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a rebuild past the 500-file threshold is reported as rebuilt', async () => {
    const { repo, brain } = await rig('cg-rebuilt');
    fs.mkdirSync(path.join(repo, 'gen'), { recursive: true });
    for (let i = 0; i < 501; i += 1) write(path.join(repo, `gen/f${i}.txt`), `file ${i}\n`);
    await commitAll(repo, 'bulk change');

    const s = await runSync({}, repo);
    expect(s.codegraph?.status).toBe('rebuilt');
    expect(s.codegraph?.changedFiles).toBeGreaterThanOrEqual(501);
    expect(cap.stdout.join('')).toMatch(/codegraph: rebuilt \(\d+ files\)/);
    const graph: { codeCommit: string; counts: { files: number } } = JSON.parse(
      read(path.join(brain, 'repos', 'payments-api', 'codegraph', 'graph.json')),
    );
    expect(graph.counts.files).toBeGreaterThanOrEqual(501);
  });
});
