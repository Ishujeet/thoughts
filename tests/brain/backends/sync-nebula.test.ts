/**
 * specs/16 acceptance: "Two machines write the same nebula thought
 * concurrently → second `sync` finishes with a warning and a `log.md` note;
 * the store's version wins." `sync` keeps exit 0 — the nebula row of the
 * specs/16 sync table is store wins, never exit 4.
 *
 * The transport is mocked at the seam src/brain/backends/nebula.ts imports (CI
 * has no NebulaGraph server); the connect path itself is real.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSync } from '../../../src/commands/sync.js';
import { NebulaBackend } from '../../../src/brain/backends/nebula.js';
import { cleanupMachines, capture, makeCodeRepo, makeMachine } from '../../commands/helpers.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../src/brain/config.js';
import { FakeNebulaClient, FakeNebulaSpace } from './fakenebula.js';

const spaceRef: { space: FakeNebulaSpace | undefined } = { space: undefined };

vi.mock('../../../src/brain/backends/nebula-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/brain/backends/nebula-client.js')>();
  const { FakeNebulaClient } = await import('./fakenebula.js');
  return {
    ...actual,
    NebulaHttpClient: class {
      constructor(_connectionString: string) {
        return new FakeNebulaClient(spaceRef.space!);
      }
    } as unknown as typeof actual.NebulaHttpClient,
  };
});

const DOC = ['---', 'type: Spec', 'title: A', 'status: draft', 'repo: demo', 'generated:', '  by: human:qa', '  at: 2026-09-10T00:00:00.000Z', '---', '# A', ''].join('\n');
const PATH = 'repos/demo/specs/2026-09-10-a.md';

beforeEach(() => {
  spaceRef.space = undefined;
});

afterEach(async () => {
  delete process.env['THOUGHTS_TEST_NEBULA'];
  spaceRef.space = undefined;
  await cleanupMachines();
});

describe('sync on a nebula brain (specs/16 sync table: store wins)', () => {
  it('finishes with a warning and a log.md note when the store moved on; the store version wins', async () => {
    const machine = await makeMachine('sync-nebula');
    const repoRoot = await makeCodeRepo(path.join(machine.root, 'code', 'demo'));
    const brainRoot = path.join(machine.root, '.thoughts', 'brains', 'acme-brain');
    fs.mkdirSync(brainRoot, { recursive: true });
    fs.writeFileSync(
      path.join(brainRoot, 'brain.yml'),
      ['okf_version: "0.2"', 'kind: project', 'name: acme', 'backend:', '  kind: nebula', '  space: acme_brain', 'repos: []', 'kinds: {}', 'templates:', '  source: builtin', ''].join('\n'),
    );
    fs.writeFileSync(path.join(repoRoot, '.thoughts.yml'), ['brain: nebula:acme-brain', 'repo_id: demo', 'tools: []', ''].join('\n'));
    process.env['THOUGHTS_TEST_NEBULA'] = 'nebula://localhost:9669/acme_brain';
    const global = await loadGlobalConfig();
    global.brains['acme-brain'] = { remote: 'nebula:acme-brain', connection_ref: 'env:THOUGHTS_TEST_NEBULA' };
    await saveGlobalConfig(global);

    // machine 1 seeded the store and the workspace
    spaceRef.space = new FakeNebulaSpace();
    const writer = new NebulaBackend({ brainId: 'acme-brain', workspace: brainRoot, client: new FakeNebulaClient(spaceRef.space), space: 'acme_brain', now: () => new Date('2026-09-11T00:00:00.000Z') });
    await writer.provision();
    await writer.write(PATH, DOC);
    await writer.write('brain.yml', fs.readFileSync(path.join(brainRoot, 'brain.yml'), 'utf8'));
    await writer.commit('thoughts(demo): 1 added, 0 updated');
    await writer.write('log.md', '# Log\n');
    await writer.commit('thoughts(brain): indexes');
    fs.symlinkSync(brainRoot, path.join(repoRoot, 'thoughts'));

    // machine 2 lands a write on the same thought while this machine edits it
    const peerWorkspace = path.join(machine.root, 'peer');
    fs.mkdirSync(peerWorkspace, { recursive: true });
    const other = new NebulaBackend({ brainId: 'acme-brain', workspace: peerWorkspace, client: new FakeNebulaClient(spaceRef.space), space: 'acme_brain' });
    await other.pull(undefined);
    await other.write(PATH, DOC.replace('# A', '# Theirs'));
    await other.commit('thoughts(demo): 1 updated');
    fs.writeFileSync(path.join(brainRoot, PATH), DOC.replace('# A', '# Ours'));

    const captured = capture();
    try {
      const result = await runSync({ json: true, now: new Date('2026-09-12T00:00:00.000Z') }, repoRoot);
      // store wins: the store carries the other machine's version...
      const vertex = new FakeNebulaClient(spaceRef.space).thought(PATH)!;
      expect(String(vertex['document'])).toBe(DOC.replace('# A', '# Theirs'));
      // ...the workspace was brought back to it, with a note in log.md
      expect(fs.readFileSync(path.join(brainRoot, PATH), 'utf8')).toBe(DOC.replace('# A', '# Theirs'));
      expect(fs.readFileSync(path.join(brainRoot, 'log.md'), 'utf8')).toContain('store wins');
      expect(result.storeWins).toEqual([PATH]);
      expect(captured.stderr.join('')).toContain('store won for');
      expect(captured.stderr.join('')).toContain('specs/16');
      // exit code: sync finished and pushed, it did not conflict
      expect(result.pushed).toBe(true);
    } finally {
      captured.restore();
    }
  });
});
