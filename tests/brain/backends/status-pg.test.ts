/**
 * specs/16 acceptance: `thoughts status --json` against a psql brain issues
 * zero workspace file reads for the thought rows it reports — the rows come
 * from the store's columns (specs/16 Representation rule 3), and the workspace
 * is compared against the store through the materialisation stamps.
 *
 * The `pg` module is mocked at the seam src/brain/backends/pg.ts imports, so
 * the real connect path (dynamic import → `new pg.Client`) is exercised with
 * no server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStatus } from '../../../src/commands/status.js';
import { PgBackend } from '../../../src/brain/backends/pg.js';
import { FakePgClient, FakePgStore } from './fakepg.js';
import { cleanupMachines, makeMachine } from '../../commands/helpers.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../src/brain/config.js';

const store = new FakePgStore();
const connectionStrings: string[] = [];

vi.mock('pg', () => {
  class Client {
    constructor(opts: { connectionString: string }) {
      const client = new FakePgClient(store);
      client.connectionString = opts.connectionString;
      connectionStrings.push(opts.connectionString);
      return client;
    }
  }
  return { default: { Client } };
});

const DOC = [
  '---',
  'type: Spec',
  'title: Refund endpoint',
  'status: draft',
  'repo: payments-api',
  'generated:',
  '  by: human:qa',
  '  at: 2026-09-10T00:00:00.000Z',
  '---',
  '# Refund endpoint',
  '',
  'Idempotent refunds.',
  '',
].join('\n');

let machineRoot = '';
let brainRoot = '';

beforeEach(async () => {
  const machine = await makeMachine('status-pg');
  machineRoot = machine.root;
  brainRoot = path.join(machineRoot, '.thoughts', 'brains', 'acme-brain');
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.writeFileSync(
    path.join(brainRoot, 'brain.yml'),
    ['okf_version: "0.2"', 'kind: project', 'name: acme', 'backend:', '  kind: psql', '  database: acme_brain', 'repos: []', 'kinds: {}', 'templates:', '  source: builtin', ''].join('\n'),
  );
  process.env['THOUGHTS_TEST_PG'] = 'postgres://thoughts:sup3rs3cret@localhost:5432/acme_brain';
  const global = await loadGlobalConfig();
  global.brains['acme-brain'] = { remote: 'postgres:acme-brain', connection_ref: 'env:THOUGHTS_TEST_PG' };
  await saveGlobalConfig(global);
  // Seed the store the way `init` + `sync` would: rows in the store, the
  // workspace materialised, meta.yml carrying last_rev.
  const writer = new PgBackend({ brainId: 'acme-brain', workspace: brainRoot, client: new FakePgClient(store), now: () => new Date('2026-09-11T00:00:00.000Z') });
  await writer.provision();
  await writer.write('repos/payments-api/specs/2026-09-10-refund.md', DOC);
  await writer.write('brain.yml', fs.readFileSync(path.join(brainRoot, 'brain.yml'), 'utf8'));
  await writer.commit('thoughts(payments-api): 1 added, 0 updated');
  await writer.write('log.md', '# Log\n');
  await writer.commit('thoughts(brain): indexes');
});

afterEach(async () => {
  delete process.env['THOUGHTS_TEST_PG'];
  store.thoughts.clear();
  store.bundleFiles.clear();
  store.changeLog.length = 0;
  store.history.length = 0;
  store.meta.clear();
  store.meta.set('rev', '1');
  await cleanupMachines();
});

describe('status --json against a psql brain (specs/16 acceptance)', () => {
  it('serves the rows from the store with zero workspace file reads', async () => {
    const readFile = vi.spyOn(fs.promises, 'readFile');
    try {
      const result = await runStatus({ json: true, brain: 'acme-brain', graph: false, now: new Date('2026-09-12T00:00:00.000Z') }, machineRoot);
      expect(result.groups).toHaveLength(1);
      const row = result.groups[0]!.rows[0]!;
      expect(row.path).toBe('/repos/payments-api/specs/2026-09-10-refund.md');
      expect(row.title).toBe('Refund endpoint');
      expect(row.status).toBe('draft');
      expect(row.modifiedAt).toBe('2026-09-11T00:00:00.000Z');
      expect(result.unsynced).toEqual([]);
      // zero workspace .md reads for the thought rows
      const reads = readFile.mock.calls.map((c) => String(c[0]));
      const mdReads = reads.filter((f) => f.endsWith('.md'));
      expect(mdReads).toEqual([]);
      expect(reads.some((f) => f.endsWith('brain.yml'))).toBe(true);
    } finally {
      readFile.mockRestore();
    }
  });

  it('connects through the cred-ref and never stores or prints the connection string', async () => {
    await runStatus({ json: true, brain: 'acme-brain', graph: false, now: new Date('2026-09-12T00:00:00.000Z') }, machineRoot);
    expect(connectionStrings.length).toBeGreaterThan(0);
    expect(connectionStrings[0]).toBe('postgres://thoughts:sup3rs3cret@localhost:5432/acme_brain');
    const brainFiles = readAllFiles(brainRoot);
    for (const content of brainFiles) expect(content).not.toContain('sup3rs3cret');
    expect(fs.existsSync(path.join(brainRoot, 'brain.yml'))).toBe(true);
  });
});

function readAllFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return out;
}
