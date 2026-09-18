/**
 * Fail soft (specs/17 "Fail soft, exactly one warning"): with the grammars
 * unavailable the whole codegraph step is skipped for that repo with exactly
 * one warning naming the cause, and the sync still succeeds — the graph is
 * never a reason for a sync to fail.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { runNew } from '../../src/commands/new.js';
import { runSync } from '../../src/commands/sync.js';
import { resetCodegraphWarnings } from '../../src/commands/codegraph-step.js';
import * as git from '../../src/git.js';
import { makeBareBrain, makeCodeRepo, makeMachine, capture, cleanupMachines, commitAll, read, type Captured } from '../commands/helpers.js';

// The grammars are unavailable in this process: exactly the acceptance case of
// a broken/missing `web-tree-sitter` install.
vi.mock('web-tree-sitter', () => {
  class Parser {
    static init(): Promise<void> {
      return Promise.reject(new Error('cannot instantiate wasm module'));
    }
  }
  return { Parser };
});

let cap: Captured;
beforeEach(async () => {
  cap = capture();
  resetCodegraphWarnings();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

describe('codegraph fail soft', () => {
  it('a sync with unavailable grammars prints one warning and still commits', async () => {
    const host = await makeMachine('remote');
    const bare = await makeBareBrain(host.root);
    const a = await makeMachine('a');
    const repo = await makeCodeRepo(path.join(a.root, 'payments-api'));
    fs.writeFileSync(path.join(repo, 'src.ts'), 'export function x(): number { return 1; }\n');
    await commitAll(repo, 'add code');

    const r = await runInit({ yes: true, brain: bare }, repo);
    const brain = r.brainRoot;
    // init is not a failure: the row says skipped with the cause.
    const row = r.steps.find((s) => s.step.startsWith('codegraph'));
    expect(row).toMatchObject({ state: 'skipped' });

    const warnings = cap.stderr.join('').match(/codegraph skipped for payments-api: .*/g) ?? [];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('web-tree-sitter');

    // The sync still committed the thought and pushed it.
    a.use();
    cap.stdout.length = 0;
    const t = await runNew('spec', 'Refund endpoint', {}, repo);
    const s = await runSync({}, repo);
    expect(s.pushed).toBe(true);
    expect(fs.existsSync(path.join(brain, t.path.slice(1)))).toBe(true);
    // No graph was stored, and nothing else broke.
    expect(read(path.join(brain, t.path.slice(1)))).toContain('Refund endpoint');
    expect((await git.statusPorcelain(brain)).length).toBe(0);
  });

  it('a repo without commits is skipped with one warning, not an error', async () => {
    const host = await makeMachine('remote2');
    const bare = await makeBareBrain(host.root);
    const a = await makeMachine('a2');
    const repo = path.join(a.root, 'empty-repo');
    fs.mkdirSync(repo, { recursive: true });
    await git.init(repo);
    const r = await runInit({ yes: true, brain: bare }, repo);
    expect(r.steps.find((s) => s.step.startsWith('codegraph'))).toMatchObject({ state: 'skipped' });
    expect(cap.stderr.join('')).toContain('no commits');
  });

  it('sync inside a brain clone skips the step silently (no code repo)', async () => {
    const host = await makeMachine('remote3');
    const bare = await makeBareBrain(host.root);
    const a = await makeMachine('a3');
    const repo = await makeCodeRepo(path.join(a.root, 'payments-api'));
    const r = await runInit({ yes: true, brain: bare }, repo);
    cap.stdout.length = 0;
    cap.stderr.length = 0;
    resetCodegraphWarnings();
    // A brain clone has no code repo: nothing to graph, no warning.
    await import('../../src/commands/sync.js').then((m) => m.runSync({}, r.brainRoot));
    expect(cap.stderr.join('')).not.toContain('codegraph skipped');
  });
});
