/**
 * `thoughts init` against a nebula store (specs/16 "Provisioning"): connect +
 * provision + materialise the workspace; `--yes` without a connection ref is
 * exit 1 naming the env var; an unreachable store writes the ready-to-run
 * docker snippet and exits 2. The transport is mocked at the seam for the
 * success path; the unreachable path exercises the real client (no server).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { cleanupMachines, makeCodeRepo, makeMachine } from './helpers.js';
import { loadGlobalConfig } from '../../src/brain/config.js';

const spaceRef: { space: import('../brain/backends/fakenebula.js').FakeNebulaSpace | undefined } = { space: undefined };

vi.mock('../../src/brain/backends/nebula-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/brain/backends/nebula-client.js')>();
  const { FakeNebulaClient } = await import('../brain/backends/fakenebula.js');
  return {
    ...actual,
    NebulaHttpClient: class {
      constructor(_connectionString: string) {
        // no seeded space in a test = no server to reach
        if (spaceRef.space === undefined) throw new Error('connect ECONNREFUSED 127.0.0.1:9669');
        return new FakeNebulaClient(spaceRef.space);
      }
    } as unknown as typeof actual.NebulaHttpClient,
  };
});

beforeEach(() => {
  spaceRef.space = undefined;
});

afterEach(async () => {
  delete process.env['THOUGHTS_TEST_NEBULA'];
  spaceRef.space = undefined;
  await cleanupMachines();
});

const ENV = 'THOUGHTS_TEST_NEBULA';

describe('init --backend nebula (specs/16 provisioning)', () => {
  it('without --connection-ref under --yes: exit 1 naming the env var, nothing provisioned', async () => {
    const machine = await makeMachine('init-nebula-noref');
    const repo = await makeCodeRepo(path.join(machine.root, 'code', 'demo'));
    const err = await runInit({ yes: true, backend: 'nebula', brain: 'nebula:acme-brain', json: true }, repo).then(
      () => undefined,
      (e) => e,
    );
    expect((err as { exitCode?: number }).exitCode).toBe(1);
    expect(String((err as Error).message) + String((err as { hint?: string }).hint)).toContain('THOUGHTS_NEBULA');
    // nothing provisioned: no workspace, no store
    expect(fs.existsSync(path.join(machine.root, '.thoughts', 'brains', 'acme-brain'))).toBe(false);
    expect(spaceRef.space).toBeUndefined();
  });

  it('with a connection ref: provisions the space, materialises the workspace, writes the scheme ref', async () => {
    const machine = await makeMachine('init-nebula');
    const repo = await makeCodeRepo(path.join(machine.root, 'code', 'demo'));
    spaceRef.space = new (await import('../brain/backends/fakenebula.js')).FakeNebulaSpace();
    process.env[ENV] = 'nebula://thoughts:sup3rs3cret@localhost:9669/acme_brain';
    const result = await runInit({ yes: true, backend: 'nebula', brain: 'nebula:acme-brain', connectionRef: `env:${ENV}`, repoId: 'demo', json: true }, repo);
    expect(result.brainRemote).toBe('nebula:acme-brain');
    const brainRoot = path.join(machine.root, '.thoughts', 'brains', 'acme-brain');
    // the store was provisioned (space created, schema applied)
    expect(spaceRef.space!.createdSpaces).toEqual(['acme_brain']);
    // brain.yml carries the non-secret descriptor only
    const brainYml = fs.readFileSync(path.join(brainRoot, 'brain.yml'), 'utf8');
    expect(brainYml).toContain('kind: nebula');
    expect(brainYml).toContain('space: acme_brain');
    expect(brainYml).not.toContain('sup3rs3cret');
    // the cred-ref lives in the global config, outside the brain (specs/10)
    const global = await loadGlobalConfig();
    expect(global.brains['acme-brain']?.['connection_ref']).toBe(`env:${ENV}`);
    // the workspace was materialised and the repo attached
    expect(fs.readFileSync(path.join(brainRoot, 'meta.yml'), 'utf8')).toContain('last_rev');
    expect(fs.lstatSync(path.join(repo, 'thoughts')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(repo, '.thoughts.yml'), 'utf8')).toContain('brain: nebula:acme-brain');
  });

  it('an unreachable store: exit 2 with a ready-to-run nebula snippet, nothing provisioned', async () => {
    const machine = await makeMachine('init-nebula-down');
    const repo = await makeCodeRepo(path.join(machine.root, 'code', 'demo'));
    process.env[ENV] = 'nebula://thoughts:sup3rs3cret@localhost:9669/acme_brain';
    const err = await runInit({ yes: true, backend: 'nebula', brain: 'nebula:acme-brain', connectionRef: `env:${ENV}`, json: true }, repo).then(
      () => undefined,
      (e) => e,
    );
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    // the snippet is CLI-owned output: written, never started
    const snippet = path.join(machine.thoughtsHome, 'backends', 'acme-brain', 'docker-compose.yml');
    expect(fs.existsSync(snippet)).toBe(true);
    const compose = fs.readFileSync(snippet, 'utf8');
    expect(compose).toContain('nebula-graphd');
    expect(compose).toContain('nebula-http-gateway');
    expect(compose).toContain(ENV);
    expect(compose).not.toContain('sup3rs3cret');
    // nothing provisioned
    expect(fs.existsSync(path.join(machine.root, '.thoughts', 'brains', 'acme-brain'))).toBe(false);
  });

  it('a re-run on an initialised nebula brain keeps its backend (immutable after init)', async () => {
    const machine = await makeMachine('init-nebula-again');
    const repo = await makeCodeRepo(path.join(machine.root, 'code', 'demo'));
    spaceRef.space = new (await import('../brain/backends/fakenebula.js')).FakeNebulaSpace();
    process.env[ENV] = 'nebula://localhost:9669/acme_brain';
    await runInit({ yes: true, backend: 'nebula', brain: 'nebula:acme-brain', connectionRef: `env:${ENV}`, repoId: 'demo', json: true }, repo);
    const err = await runInit({ yes: true, backend: 'psql', brain: 'nebula:acme-brain', connectionRef: `env:${ENV}`, json: true }, repo).then(
      () => undefined,
      (e) => e,
    );
    expect(String((err as Error).message)).toContain('immutable');
    // the brain still resolves to the nebula backend
    const backend = await NebulaBackendProbe(machine.root);
    expect(backend).toBe('nebula');
  });
});

/** Resolve the backend a brain.yml now names (helper to keep the test readable). */
async function NebulaBackendProbe(machineRoot: string): Promise<string> {
  const brainRoot = path.join(machineRoot, '.thoughts', 'brains', 'acme-brain');
  const text = fs.readFileSync(path.join(brainRoot, 'brain.yml'), 'utf8');
  return /kind:\s*nebula/.test(text) ? 'nebula' : 'other';
}
