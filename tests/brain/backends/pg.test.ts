/**
 * The BrainBackend contract against PgBackend, driven by a fake `pg` client at
 * the seam (specs/16 "Testing constraint": CI has no PostgreSQL server), plus
 * the psql-specific behaviour: cred-ref resolution, unreachable-store exits,
 * native representation, and the codegraph tables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PgBackend, buildThoughtQuery, docToRow, rowToDoc, FTS_EXPRESSION, advisoryKey, splitSqlStatements, loadPgSchema } from '../../../src/brain/backends/pg.js';
import { resolveCredRef, parseCredRef, maskConnectionString, isCredRef } from '../../../src/brain/backends/credref.js';
import { FakePgClient, FakePgStore } from './fakepg.js';
import { DEFAULT_KINDS, ExitCode, type BrainConfig } from '../../../src/types.js';
import { cleanupMachines, makeMachine } from '../../commands/helpers.js';
import { expectThoughtsError } from '../../commands/helpers.js';
import { loadGlobalConfig, saveGlobalConfig } from '../../../src/brain/config.js';
import { backendContract, type BackendFixture } from './checklist.js';

afterEach(async () => {
  await cleanupMachines();
});

describe('BrainBackend contract: psql', () => {
  backendContract('psql', async (): Promise<BackendFixture> => {
    const machine = await makeMachine('pg');
    const store = new FakePgStore();
    let peers = 0;
    const workspace = (): string => {
      const dir = path.join(machine.root, 'ws-' + peers);
      peers += 1;
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const brain: BrainConfig = {
      okf_version: '0.2',
      kind: 'project',
      name: 'contract-brain',
      backend: { kind: 'psql', database: 'contract_brain' },
      repos: [],
      kinds: { ...DEFAULT_KINDS },
      templates: { source: 'builtin' },
    };
    return {
      backend: new PgBackend({ brainId: 'contract-brain', workspace: workspace(), client: new FakePgClient(store) }),
      peer: async () => new PgBackend({ brainId: 'contract-brain', workspace: workspace(), client: new FakePgClient(store) }),
      brain,
    };
  });
});

describe('pg backend: cred-ref resolution (specs/10, specs/16)', () => {
  it('resolves env:VAR to the connection string', async () => {
    process.env['THOUGHTS_TEST_PG'] = 'postgres://qa:pw@localhost:5432/qa';
    try {
      expect(await resolveCredRef('env:THOUGHTS_TEST_PG')).toBe('postgres://qa:pw@localhost:5432/qa');
    } finally {
      delete process.env['THOUGHTS_TEST_PG'];
    }
  });

  it('refuses a missing env var with exit 1 naming the variable', async () => {
    delete process.env['THOUGHTS_DEFINITELY_UNSET_PG'];
    const err = await expectThoughtsError(() => resolveCredRef('env:THOUGHTS_DEFINITELY_UNSET_PG'));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.message).toContain('env:THOUGHTS_DEFINITELY_UNSET_PG');
    expect(err.message).toContain('THOUGHTS_DEFINITELY_UNSET_PG');
  });

  it('resolves keyref:name from the global config and refuses a missing entry', async () => {
    const machine = await makeMachine('pg-keyref');
    const global = await loadGlobalConfig();
    global['keyrefs'] = { 'acme-brain': 'postgres://qa:pw@localhost:5432/acme' };
    await saveGlobalConfig(global);
    expect(await resolveCredRef('keyref:acme-brain')).toBe('postgres://qa:pw@localhost:5432/acme');
    const missing = await expectThoughtsError(() => resolveCredRef('keyref:nope'));
    expect(missing.exitCode).toBe(ExitCode.Validation);
    expect(missing.message).toContain('keyref:nope');
    expect(machine.root.length).toBeGreaterThan(0);
  });

  it('refuses anything that is not a ref — a connection string is never accepted', async () => {
    for (const bad of ['postgres://u:p@h/db', 'postgres:acme', 'env', 'keyref:', 'file:/tmp/x']) {
      const err = await expectThoughtsError(async () => parseCredRef(bad));
      expect(err.exitCode).toBe(ExitCode.Validation);
      expect(err.hint).toContain('never a connection string');
    }
    expect(isCredRef('env:BRAIN_PG')).toBe(true);
    expect(isCredRef('postgres://u:p@h/db')).toBe(false);
  });

  it('masks the password out of any connection string a message might carry', () => {
    const masked = maskConnectionString('postgres://thoughts:super-secret@db.internal:5432/acme_brain');
    expect(masked).not.toContain('super-secret');
    expect(masked).toContain('***');
    expect(masked).toContain('db.internal');
    expect(maskConnectionString("host=db password=super-secret dbname=acme")).not.toContain('super-secret');
  });
});

describe('pg backend: connection failures are named, never fatal to the workspace', () => {
  it('a missing optional driver degrades into a named exit 1', async () => {
    const machine = await makeMachine('pg-driver');
    process.env['THOUGHTS_TEST_PG'] = 'postgres://qa@localhost:5432/qa';
    try {
      const backend = new PgBackend({
        brainId: 'b',
        workspace: path.join(machine.root, 'ws'),
        connectionRef: 'env:THOUGHTS_TEST_PG',
        connect: async () => {
          const e = new Error("Cannot find package 'pg'");
          (e as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
          throw e;
        },
      });
      const health = await backend.health();
      expect(health.ok).toBe(false);
      expect(health.detail).toContain('driver is not installed');
      const err = await expectThoughtsError(() => backend.commit('thoughts(b): 1 added'));
      expect(err.exitCode).toBe(ExitCode.Validation);
      expect(err.message).toContain('driver');
    } finally {
      delete process.env['THOUGHTS_TEST_PG'];
    }
  });

  it('an unreachable store is exit 2, masked, and keeps the local work', async () => {
    const machine = await makeMachine('pg-down');
    const workspace = path.join(machine.root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    process.env['THOUGHTS_TEST_PG'] = 'postgres://qa:sup3rs3cret@localhost:5432/qa';
    const backend = new PgBackend({
      brainId: 'acme',
      workspace,
      connectionRef: 'env:THOUGHTS_TEST_PG',
      connect: async (cs) => {
        throw new Error(`connection refused for ${cs}`);
      },
    });
    const health = await backend.health();
    expect(health.ok).toBe(false);
    const err = await expectThoughtsError(() => backend.commit('thoughts(acme): 1 added'));
    expect(err.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect(err.message).toContain('unreachable');
    // the credential is masked, never echoed (specs/16 "Credential references")
    expect(err.message).not.toContain('sup3rs3cret');
    expect(err.message).toContain('***');
    // fail soft (principle 5): nothing was lost
    expect(fs.existsSync(path.join(workspace, 'shared'))).toBe(false);
  });

  it('health() reports unreachable without throwing and without the credential', async () => {
    const machine = await makeMachine('pg-health');
    const backend = new PgBackend({
      brainId: 'acme',
      workspace: path.join(machine.root, 'ws'),
      connectionRef: 'env:THOUGHTS_DEFINITELY_UNSET_PG',
    });
    const health = await backend.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('THOUGHTS_DEFINITELY_UNSET_PG');
  });
});

describe('pg backend: native representation (specs/16 Representation, D22)', () => {
  const DOC = [
    '---',
    'type: Spec',
    'title: Refund endpoint',
    'status: draft',
    'repo: payments-api',
    'tags:',
    '  - api',
    'generated:',
    '  by: human:qa',
    '  at: 2026-09-10T00:00:00.000Z',
    '---',
    '# Refund endpoint',
    '',
    'Idempotent refunds.',
    '',
  ].join('\n');

  it('splits a document into columns + jsonb + body', () => {
    const row = docToRow('repos/payments-api/specs/2026-09-10-refund.md', DOC, 3, 'thoughts', 'acme', new Date('2026-09-11T00:00:00.000Z'));
    expect(row.path).toBe('repos/payments-api/specs/2026-09-10-refund.md');
    expect(row.zone).toBe('repos');
    expect(row.repo_id).toBe('payments-api');
    expect(row.kind).toBe('specs');
    expect(row.title).toBe('Refund endpoint');
    expect(row.status).toBe('draft');
    expect(row.created).toBe('2026-09-10T00:00:00.000Z');
    expect(row.body).toContain('# Refund endpoint');
    expect(row.frontmatter).toMatchObject({ type: 'Spec', title: 'Refund endpoint', repo: 'payments-api' });
    // unknown frontmatter fields survive (OKF rule)
    expect(row.frontmatter).toMatchObject({ tags: ['api'] });
    expect(row.document).toBe(DOC);
  });

  it('rebuilds the document from the columns when the byte-exact copy is absent', () => {
    const row = docToRow('shared/specs/2026-09-10-a.md', DOC, 1, undefined, 'acme', new Date('2026-09-11T00:00:00.000Z'));
    const rebuilt = rowToDoc({ ...row, document: '' });
    expect(rebuilt).toContain('title: "Refund endpoint"');
    expect(rebuilt).toContain('# Refund endpoint');
    // round-trips through a second split: the columns still carry the document
    const again = docToRow(row.path, rebuilt, 1, undefined, 'acme', new Date('2026-09-11T00:00:00.000Z'));
    expect(again.title).toBe(row.title);
    expect(again.status).toBe(row.status);
    expect(again.kind).toBe(row.kind);
  });

  it('the byte-exact document column wins for materialisation', () => {
    const row = docToRow('shared/specs/a.md', DOC, 1, undefined, 'acme', new Date());
    expect(rowToDoc(row)).toBe(DOC);
  });

  it('queries filter on columns and full-text search, never on a walk', () => {
    const { sql, params } = buildThoughtQuery({ repoId: 'payments-api', kind: 'specs', status: 'draft', text: 'refund endpoint', limit: 5 });
    expect(sql).toContain('FROM thoughts');
    expect(sql).toContain('repo_id = $1');
    expect(sql).toContain('kind = $2');
    expect(sql).toContain('status = $3');
    expect(sql).toContain(FTS_EXPRESSION);
    expect(sql).toContain("@@ websearch_to_tsquery('english', $4)");
    expect(sql).toContain('LIMIT 5');
    expect(params).toEqual(['payments-api', 'specs', 'draft', 'refund endpoint']);
    expect(sql).not.toContain('pg_readfile');
  });

  it('the pull filter is revision > last_rev (specs/16 pull table)', () => {
    const { sql, params } = buildThoughtQuery({ sinceRevision: 12 });
    expect(sql).toContain('revision > $1');
    expect(params).toEqual([12]);
  });

  it('searchThoughts serves matched rows from the store', async () => {
    const machine = await makeMachine('pg-search');
    const store = new FakePgStore();
    const backend = new PgBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client: new FakePgClient(store) });
    await backend.write('repos/a/specs/2026-09-10-a.md', DOC.replace('payments-api', 'a'));
    await backend.commit('thoughts(a): 1 added');
    await backend.write(
      'repos/b/plans/2026-09-10-b.md',
      DOC.replace('payments-api', 'b').replace('Refund endpoint', 'Ledger').replace('Idempotent refunds.', 'Ledger entries balance.'),
    );
    await backend.commit('thoughts(b): 1 added');
    const hits = await backend.searchThoughts({ text: 'idempotent refunds' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe('repos/a/specs/2026-09-10-a.md');
    const byRepo = await backend.searchThoughts({ repoId: 'b' });
    expect(byRepo.map((h) => h.path)).toEqual(['repos/b/plans/2026-09-10-b.md']);
  });
});

describe('pg backend: store tables and metadata', () => {
  it('writes thought rows as columns, keeps history, and bumps one revision per commit', async () => {
    const machine = await makeMachine('pg-tables');
    const client = new FakePgClient();
    const backend = new PgBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    await backend.write('shared/specs/2026-09-10-a.md', DOC_A);
    const rev = await backend.commit('thoughts(brain): 1 added, 0 updated');
    expect(rev).toBe('2');
    expect(client.head).toBe(2);
    const row = client.thought('shared/specs/2026-09-10-a.md')!;
    expect(row.kind).toBe('specs');
    expect(row.zone).toBe('shared');
    expect(row.repo_id).toBe('shared');
    expect(row.frontmatter).toMatchObject({ title: 'A' });
    expect(client.store.history).toHaveLength(1);
    expect(client.store.history[0]!.document).toBe(DOC_A);
    expect(client.store.changeLog[0]).toMatchObject({ change: 'added', path: 'shared/specs/2026-09-10-a.md' });
    expect(await backend.messageOf('2')).toBe('thoughts(brain): 1 added, 0 updated');
  });

  it('carries last_rev in the workspace meta.yml and behindCount() from store metadata', async () => {
    const machine = await makeMachine('pg-meta');
    const workspace = path.join(machine.root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const client = new FakePgClient();
    const backend = new PgBackend({ brainId: 'acme', workspace, client });
    await backend.write('shared/specs/2026-09-10-a.md', DOC_A);
    await backend.commit('thoughts(brain): 1 added, 0 updated');
    const meta = fs.readFileSync(path.join(workspace, 'meta.yml'), 'utf8');
    expect(meta).toContain('last_rev: 2');
    expect(await backend.revision()).toBe('2');
    expect(await backend.upstreamRevision()).toBe('2');
    expect(await backend.behindCount()).toBe(0);
    // another machine advances the store
    const store = client.store;
    store.meta.set('rev', '5');
    expect(await backend.behindCount()).toBe(3);
    expect(await backend.upstreamRevision()).toBe('5');
  });

  it('a conflict aborts the transaction: the store keeps the other machine, the workspace keeps the edit', async () => {
    const machine = await makeMachine('pg-conflict');
    const store = new FakePgStore();
    const workspace = path.join(machine.root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const backend = new PgBackend({ brainId: 'acme', workspace, client: new FakePgClient(store) });
    await backend.write('shared/specs/2026-09-10-a.md', DOC_A);
    await backend.commit('base');
    // Both machines read the same base revision, then both write.
    await backend.write('shared/specs/2026-09-10-a.md', DOC_C);
    const other = new PgBackend({ brainId: 'acme', workspace: path.join(machine.root, 'peer'), client: new FakePgClient(store) });
    await other.pull('0');
    await other.write('shared/specs/2026-09-10-a.md', DOC_B);
    await other.commit('other');
    await other.push({ paths: [], message: 'other', logEntries: [] });

    const err = await expectThoughtsError(() => backend.commit('ours'));
    expect(err.exitCode).toBe(ExitCode.Conflict);
    expect(String(err.message)).toContain('shared/specs/2026-09-10-a.md');
    // store wins the row, the local edit survives in the workspace, nothing partial landed
    expect(store.thoughts.get('shared/specs/2026-09-10-a.md')!.document).toBe(DOC_B);
    expect(fs.readFileSync(path.join(workspace, 'shared/specs/2026-09-10-a.md'), 'utf8')).toBe(DOC_C);
    expect(store.meta.get('rev')).toBe('3');
    expect((await backend.read('shared/specs/2026-09-10-a.md'))).toBe(DOC_C);
    expect(await backend.conflictInfo()).toEqual({ conflicted: ['shared/specs/2026-09-10-a.md'], inProgress: false });
    expect(await backend.resolveConflicts({ brain: { okf_version: '0.2', kind: 'project', name: 'b', repos: [], kinds: DEFAULT_KINDS, templates: { source: 'builtin' } }, log: { date: '2026-09-10', entries: [] } })).toEqual([
      'shared/specs/2026-09-10-a.md',
    ]);
  });

  it('round-trips the codegraph document through codegraph_nodes/edges/meta', async () => {
    const machine = await makeMachine('pg-graph');
    const client = new FakePgClient();
    const backend = new PgBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    const graph = {
      version: 1,
      repoId: 'payments-api',
      codeCommit: 'abc123',
      counts: { files: 1, symbols: 1, edges: 1 },
      nodes: [
        { id: 'f1', kind: 'file', name: 'src/index.ts', path: 'src/index.ts', sha: 'aa11', codeCommit: 'abc123' },
        { id: 's1', kind: 'symbol', name: 'main', path: 'src/index.ts', symbolKind: 'function', line: 1, endLine: 2, codeCommit: 'abc123' },
      ],
      edges: [{ id: 'e1', type: 'contains', source: 'f1', target: 's1', codeCommit: 'abc123' }],
    };
    const doc = JSON.stringify(graph, null, 2) + '\n';
    await backend.saveGraph('payments-api', doc);
    expect(await backend.loadGraph('payments-api')).toBe(doc);
    expect(await backend.loadGraph('nope')).toBeUndefined();
    await backend.saveGraphMeta('payments-api', 'codeCommit: abc123\ngenerated:\n  at: 2026-09-10T00:00:00.000Z\n');
    expect(await backend.loadGraphMeta('payments-api')).toContain('abc123');
    expect(client.store.graphNodes.get('payments-api')).toHaveLength(2);
    expect(client.store.graphEdges.get('payments-api')).toHaveLength(1);
  });

  it('keeps the change log bounded without losing recent changes', async () => {
    const machine = await makeMachine('pg-bounded');
    const client = new FakePgClient();
    const backend = new PgBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    for (let i = 1; i <= 3; i += 1) {
      await backend.write(`shared/specs/2026-09-1${i}-a.md`, DOC_A.replace('# A', '# ' + i));
      await backend.commit(`thoughts(brain): ${i}`);
    }
    expect(client.store.changeLog).toHaveLength(3);
    expect(client.calls.some((c) => c.op === 'prune_log')).toBe(true);
  });

  it('provision() applies the shipped schema', async () => {
    const machine = await makeMachine('pg-provision');
    const client = new FakePgClient();
    const backend = new PgBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    const result = await backend.provision();
    expect(result.applied).toBe(true);
    expect(client.calls.some((c) => c.op === 'unknown' && c.sql.includes('CREATE TABLE IF NOT EXISTS thoughts'))).toBe(true);
  });
});

describe('pg backend: helpers', () => {
  it('derives a stable advisory lock key per brain id', () => {
    expect(advisoryKey('acme')).toBe(advisoryKey('acme'));
    expect(advisoryKey('acme')).not.toBe(advisoryKey('other'));
    expect(Number.isInteger(advisoryKey('acme'))).toBe(true);
  });

  it('splits the schema into balanced statements', () => {
    const ddl = loadPgSchema();
    const statements = splitSqlStatements(ddl);
    expect(statements.length).toBeGreaterThan(5);
    for (const statement of statements) {
      expect(statement.endsWith(';')).toBe(true);
      const depth = (statement.match(/\(/g) ?? []).length - (statement.match(/\)/g) ?? []).length;
      expect(depth).toBe(0);
    }
  });
});

const DOC_A = ['---', 'type: Spec', 'title: A', 'status: draft', 'repo: shared', 'generated:', '  by: human:qa', '  at: 2026-09-10T00:00:00.000Z', '---', '# A', ''].join('\n');
const DOC_B = DOC_A.replace('# A', '# B');
const DOC_C = DOC_A.replace('# A', '# C');
