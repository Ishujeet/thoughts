/**
 * `scan --history` (specs/15 "If a secret was already pushed") across the
 * backends: a git brain walks every commit; a nebula brain keeps a bounded
 * change log and says so before scanning rather than pretend (specs/16). The
 * nebula transport is mocked at the seam (CI has no NebulaGraph server).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runScan } from '../../../src/commands/scan.js';
import { NebulaBackend } from '../../../src/brain/backends/nebula.js';
import { SecretRefusedError } from '../../../src/commands/common.js';
import { cleanupMachines, capture, fakeGithubToken, makeMachine } from '../../commands/helpers.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../src/brain/config.js';
import { scaffoldBrain } from '../../../src/brain/layout.js';
import * as git from '../../../src/git.js';

const spaceRef: { space: import('./fakenebula.js').FakeNebulaSpace | undefined } = { space: undefined };

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

beforeEach(async () => {
  spaceRef.space = undefined;
});

afterEach(async () => {
  delete process.env['THOUGHTS_TEST_NEBULA'];
  spaceRef.space = undefined;
  await cleanupMachines();
});

describe('scan --history on a nebula brain (specs/16: bounded change log)', () => {
  it('says the history is partial, then still finds the secret in the retained revisions', async () => {
    const machine = await makeMachine('scan-nebula');
    const brainRoot = path.join(machine.root, '.thoughts', 'brains', 'acme-brain');
    fs.mkdirSync(brainRoot, { recursive: true });
    fs.writeFileSync(
      path.join(brainRoot, 'brain.yml'),
      ['okf_version: "0.2"', 'kind: project', 'name: acme', 'backend:', '  kind: nebula', '  space: acme_brain', 'repos: []', 'kinds: {}', 'templates:', '  source: builtin', ''].join('\n'),
    );
    process.env['THOUGHTS_TEST_NEBULA'] = 'nebula://localhost:9669/acme_brain';
    const global = await loadGlobalConfig();
    global.brains['acme-brain'] = { remote: 'nebula:acme-brain', connection_ref: 'env:THOUGHTS_TEST_NEBULA' };
    await saveGlobalConfig(global);

    spaceRef.space = new (await import('./fakenebula.js')).FakeNebulaSpace();
    const writer = new NebulaBackend({ brainId: 'acme-brain', workspace: brainRoot, client: new (await import('./fakenebula.js')).FakeNebulaClient(spaceRef.space), space: 'acme_brain' });
    await writer.provision();
    const doc = (secret: string): string =>
      ['---', 'type: Spec', 'title: A', 'status: draft', 'repo: shared', 'generated:', '  by: human:qa', '  at: 2026-09-10T00:00:00.000Z', '---', `token: ${secret}`, ''].join('\n');
    await writer.write('shared/specs/2026-09-10-a.md', doc(fakeGithubToken()));
    await writer.commit('thoughts(brain): 1 added, 0 updated');
    // a later revision redacts it: the working tree is clean, the past is not
    await writer.write('shared/specs/2026-09-10-a.md', doc('redacted'));
    await writer.commit('thoughts(brain): 1 updated');
    await writer.delete('log.md');

    const captured = capture();
    try {
      const err = await runScan({ history: true, brain: 'acme-brain' }, machine.root).then(
        () => undefined,
        (e) => e,
      );
      expect(captured.stderr.join('')).toContain('bounded change log');
      expect(err).toBeInstanceOf(SecretRefusedError);
      const secretErr = err as SecretRefusedError;
      // the finding names the path and the revision it leaked in, masked
      const printed = `${captured.stderr.join('')} ${JSON.stringify(secretErr.findings)}`;
      expect(printed).toContain('shared/specs/2026-09-10-a.md@2');
      expect(printed).not.toContain(fakeGithubToken());
      expect(printed).toContain('recovery order');
    } finally {
      captured.restore();
    }
  });
});

describe('scan --history on a git brain (specs/15: every commit)', () => {
  it('walks every commit and reports the finding with its revision, no partial warning', async () => {
    const machine = await makeMachine('scan-git');
    const brainRoot = path.join(machine.root, 'brains', 'git-brain');
    fs.mkdirSync(path.dirname(brainRoot), { recursive: true });
    await git.init(brainRoot);
    await scaffoldBrain(brainRoot, { name: 'git-brain', now: new Date('2026-09-01T00:00:00Z') });
    const doc = (secret: string): string =>
      ['---', 'type: Spec', 'title: A', 'status: draft', 'repo: shared', 'generated:', '  by: human:qa', '  at: 2026-09-10T00:00:00.000Z', '---', `token: ${secret}`, ''].join('\n');
    const token = fakeGithubToken();
    fs.writeFileSync(path.join(brainRoot, 'shared', 'specs', '2026-09-10-a.md'), doc(token));
    await git.addAll(brainRoot);
    await git.commit(brainRoot, 'thoughts(brain): 1 added, 0 updated');
    fs.writeFileSync(path.join(brainRoot, 'shared', 'specs', '2026-09-10-a.md'), doc('redacted'));
    await git.addAll(brainRoot);
    await git.commit(brainRoot, 'thoughts(brain): 1 updated');

    const captured = capture();
    try {
      const err = await runScan({ history: true }, brainRoot).then(
        () => undefined,
        (e) => e,
      );
      expect(captured.stderr.join('')).not.toContain('bounded change log');
      expect(err).toBeInstanceOf(SecretRefusedError);
      const printed = `${captured.stderr.join('')} ${JSON.stringify((err as SecretRefusedError).findings)}`;
      expect(printed).toContain('shared/specs/2026-09-10-a.md@');
      expect(printed).not.toContain(token);
    } finally {
      captured.restore();
    }
  });
});
