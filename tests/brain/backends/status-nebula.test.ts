/**
 * specs/16 acceptance: `thoughts status --json` against a nebula brain issues
 * zero workspace file reads for the thought rows it reports — the rows come
 * from the thought vertices (specs/16 Representation rule 3), and the
 * workspace is compared against the store through the materialisation stamps.
 *
 * The transport is mocked at the seam src/brain/backends/nebula.ts imports, so
 * the real connect path (`new NebulaHttpClient`) is exercised with no server.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStatus } from '../../../src/commands/status.js';
import { NebulaBackend } from '../../../src/brain/backends/nebula.js';
import { FakeNebulaClient, FakeNebulaSpace } from './fakenebula.js';
import { cleanupMachines, makeMachine } from '../../commands/helpers.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../src/brain/config.js';

const spaceRef: { space: FakeNebulaSpace | undefined } = { space: undefined };

vi.mock('../../../src/brain/backends/nebula-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/brain/backends/nebula-client.js')>();
  return {
    ...actual,
    // the transport the CLI would build from the cred-ref's connection string
    NebulaHttpClient: class {
      constructor(_connectionString: string) {
        return new FakeNebulaClient(spaceRef.space!);
      }
    } as unknown as typeof actual.NebulaHttpClient,
  };
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
  const machine = await makeMachine('status-nebula');
  machineRoot = machine.root;
  brainRoot = path.join(machineRoot, '.thoughts', 'brains', 'acme-brain');
  fs.mkdirSync(brainRoot, { recursive: true });
  fs.writeFileSync(
    path.join(brainRoot, 'brain.yml'),
    ['okf_version: "0.2"', 'kind: project', 'name: acme', 'backend:', '  kind: nebula', '  space: acme_brain', 'repos: []', 'kinds: {}', 'templates:', '  source: builtin', ''].join('\n'),
  );
  process.env['THOUGHTS_TEST_NEBULA'] = 'nebula://thoughts:sup3rs3cret@localhost:9669/acme_brain';
  const global = await loadGlobalConfig();
  global.brains['acme-brain'] = { remote: 'nebula:acme-brain', connection_ref: 'env:THOUGHTS_TEST_NEBULA' };
  await saveGlobalConfig(global);
  // Seed the space the way `init` + `sync` would: thought vertices in the
  // store, the workspace materialised, meta.yml carrying last_rev.
  spaceRef.space = new FakeNebulaSpace();
  const writer = new NebulaBackend({
    brainId: 'acme-brain',
    workspace: brainRoot,
    client: new FakeNebulaClient(spaceRef.space),
    space: 'acme_brain',
    now: () => new Date('2026-09-11T00:00:00.000Z'),
  });
  await writer.provision();
  await writer.write('repos/payments-api/specs/2026-09-10-refund.md', DOC);
  await writer.write('brain.yml', fs.readFileSync(path.join(brainRoot, 'brain.yml'), 'utf8'));
  await writer.commit('thoughts(payments-api): 1 added, 0 updated');
  await writer.write('log.md', '# Log\n');
  await writer.commit('thoughts(brain): indexes');
});

afterEach(async () => {
  delete process.env['THOUGHTS_TEST_NEBULA'];
  spaceRef.space = undefined;
  await cleanupMachines();
});

describe('status --json against a nebula brain (specs/16 acceptance)', () => {
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
      expect(reads.filter((f) => f.endsWith('.md'))).toEqual([]);
      expect(reads.some((f) => f.endsWith('brain.yml'))).toBe(true);
    } finally {
      readFile.mockRestore();
    }
  });

  it('connects through the cred-ref and never stores or prints the connection string', async () => {
    await runStatus({ json: true, brain: 'acme-brain', graph: false, now: new Date('2026-09-12T00:00:00.000Z') }, machineRoot);
    // brain.yml and every workspace/store-adjacent file carry the ref, not the secret
    const brainFiles = readAllFiles(brainRoot);
    for (const content of brainFiles) expect(content).not.toContain('sup3rs3cret');
    expect(fs.existsSync(path.join(brainRoot, 'brain.yml'))).toBe(true);
    expect(fs.readFileSync(path.join(brainRoot, 'brain.yml'), 'utf8')).toContain('kind: nebula');
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
