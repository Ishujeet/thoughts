/**
 * `thoughts init` provisioning for a psql brain (specs/16 "Provisioning",
 * specs/02 step 1): connect + provision + materialise, exit 1 naming the env
 * var when no connection ref is configured, exit 2 with a ready-to-run docker
 * snippet when the store is unreachable.
 *
 * The `pg` module is mocked at the seam src/brain/backends/pg.ts imports, so
 * the whole flow runs with no server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { runSync } from '../../src/commands/sync.js';
import { runStatus } from '../../src/commands/status.js';
import { PgBackend } from '../../src/brain/backends/pg.js';
import { dockerSnippetPath } from '../../src/brain/backends/snippet.js';
import { brainCloneDir, REPO_CONFIG_FILENAME } from '../../src/paths.js';
import { ExitCode, ThoughtsError } from '../../src/types.js';
import { capture, cleanupMachines, makeCodeRepo, makeMachine } from './helpers.js';
import { FakePgClient } from '../brain/backends/fakepg.js';
import { pgMock } from '../brain/backends/pgmock.js';
import { loadBrainConfig } from '../../src/brain/config.js';

vi.mock('pg', async () => {
  const { pgMock } = await import('../brain/backends/pgmock.js');
  const { FakePgClient } = await import('../brain/backends/fakepg.js');
  class Client {
    constructor() {
      const client = new FakePgClient(pgMock.store);
      const connect = client.connect.bind(client);
      client.connect = async (): Promise<void> => {
        if (pgMock.refusing) throw new Error('could not connect to server: connection refused');
        await connect();
      };
      return client;
    }
  }
  return { default: { Client } };
});

let machineRoot = '';

beforeEach(async () => {
  const machine = await makeMachine('init-pg');
  machineRoot = machine.root;
  process.env['THOUGHTS_TEST_PG'] = 'postgres://thoughts:sup3rs3cret@localhost:5432/acme_brain';
  pgMock.refusing = false;
  pgMock.store.meta.clear();
  pgMock.store.thoughts.clear();
  pgMock.store.bundleFiles.clear();
  pgMock.store.changeLog.length = 0;
  pgMock.store.history.length = 0;
});

afterEach(async () => {
  delete process.env['THOUGHTS_TEST_PG'];
  await cleanupMachines();
});

describe('init with a psql brain (specs/16 provisioning)', () => {
  it('refuses --yes with a non-git backend and no connection ref: exit 1 naming the env var, nothing provisioned', async () => {
    const repo = await makeCodeRepo(path.join(machineRoot, 'svc'));
    delete process.env['THOUGHTS_TEST_PG'];
    const err = await runInit({ yes: true, backend: 'psql', brain: 'postgres:acme-brain' }, repo).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ThoughtsError);
    expect((err as ThoughtsError).exitCode).toBe(ExitCode.Validation);
    expect((err as ThoughtsError).message).toContain('acme-brain');
    expect(`${(err as ThoughtsError).message} ${(err as ThoughtsError).hint ?? ''}`).toContain('THOUGHTS_BRAIN_PG');
    expect(fs.existsSync(path.join(machineRoot, '.thoughts', 'brains', 'acme-brain'))).toBe(false);
    expect(fs.existsSync(path.join(repo, REPO_CONFIG_FILENAME))).toBe(false);
  });

  it('an unreachable store writes a docker snippet and exits 2, losing no local work', async () => {
    const repo = await makeCodeRepo(path.join(machineRoot, 'svc'));
    pgMock.refusing = true;
    const captured = capture();
    const err = await runInit({ yes: true, backend: 'psql', brain: 'postgres:acme-brain', connectionRef: 'env:THOUGHTS_TEST_PG' }, repo).then(
      () => undefined,
      (e: unknown) => e,
    );
    captured.restore();
    expect((err as ThoughtsError).exitCode).toBe(ExitCode.RemoteUnreachable);
    const snippet = dockerSnippetPath('acme-brain');
    expect(fs.existsSync(snippet)).toBe(true);
    const text = fs.readFileSync(snippet, 'utf8');
    expect(text).toContain('postgres:16');
    expect(text).toContain('acme_brain');
    expect(text).not.toContain('sup3rs3cret');
    // nothing provisioned: no workspace, no repo config
    expect(fs.existsSync(path.join(machineRoot, '.thoughts', 'brains', 'acme-brain', 'brain.yml'))).toBe(false);
  });

  it('connects, provisions the schema, materialises the workspace and seeds the store', async () => {
    const repo = await makeCodeRepo(path.join(machineRoot, 'svc'));
    pgMock.refusing = false;
    const captured = capture();
    let result;
    try {
      result = await runInit({ yes: true, backend: 'psql', brain: 'postgres:acme-brain', connectionRef: 'env:THOUGHTS_TEST_PG' }, repo);
    } finally {
      captured.restore();
    }
    expect(result.brainRemote).toBe('postgres:acme-brain');
    const brainRoot = brainCloneDir('acme-brain');
    expect(fs.existsSync(path.join(brainRoot, 'brain.yml'))).toBe(true);
    const brain = await loadBrainConfig(brainRoot);
    expect(brain.backend).toEqual({ kind: 'psql', database: 'acme_brain' });
    // the workspace is materialised OKF markdown, and the store carries it
    expect(pgMock.store.thoughts.size).toBe(0);
    expect(pgMock.store.bundleFiles.get('brain.yml')?.document).toContain('kind: psql');
    expect(fs.existsSync(path.join(brainRoot, 'repos', 'svc', 'specs'))).toBe(true);
    // `.thoughts.yml` names the brain with the scheme (specs/16)
    expect(fs.readFileSync(path.join(repo, REPO_CONFIG_FILENAME), 'utf8')).toContain('brain: postgres:acme-brain');
    // no credential anywhere in the workspace
    for (const file of walk(brainRoot)) expect(fs.readFileSync(file, 'utf8')).not.toContain('sup3rs3cret');
    // a connection ref is shown as `env:<NAME>`, never its value
    const printed = captured.stdout.join('') + captured.stderr.join('');
    expect(printed).toContain('env:THOUGHTS_TEST_PG');
    expect(printed).not.toContain('sup3rs3cret');
  });

  it('a second machine syncs against the same store through the workspace', async () => {
    const repo = await makeCodeRepo(path.join(machineRoot, 'svc'));
    pgMock.refusing = false;
    const captured = capture();
    try {
      await runInit({ yes: true, backend: 'psql', brain: 'postgres:acme-brain', connectionRef: 'env:THOUGHTS_TEST_PG' }, repo);
    } finally {
      captured.restore();
    }
    // a thought written into the workspace round-trips through the store
    const brainRoot = brainCloneDir('acme-brain');
    const backend = new PgBackend({ brainId: 'acme-brain', workspace: brainRoot, client: new FakePgClient(pgMock.store) });
    await backend.write(
      'repos/svc/specs/2026-09-10-refund.md',
      ['---', 'type: Spec', 'title: Refund endpoint', 'status: draft', 'repo: svc', 'generated:', '  by: human:qa', '  at: 2026-09-10T00:00:00.000Z', '---', '# Refund endpoint', ''].join('\n'),
    );
    await backend.commit('thoughts(svc): 1 added, 0 updated');
    const status = await runStatus({ json: true, brain: 'postgres:acme-brain', graph: false, now: new Date('2026-09-12T00:00:00.000Z') }, repo);
    expect(status.unsynced).toEqual([]);
    expect(status.groups.some((g) => g.rows.some((r) => r.title === 'Refund endpoint'))).toBe(true);
    const capturedSync = capture();
    try {
      const sync = await runSync({ quiet: true, brain: 'postgres:acme-brain' }, repo);
      expect(sync.pulled).toBe(true);
    } finally {
      capturedSync.restore();
    }
  });
});

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else out.push(abs);
    }
  };
  visit(root);
  return out;
}

