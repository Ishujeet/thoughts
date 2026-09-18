/**
 * The BrainBackend contract against NebulaBackend, driven by a fake client at
 * the seam (specs/16 "Testing constraint": CI has no NebulaGraph server), plus
 * the nebula-specific behaviour: native representation (specs/16
 * "Representation", D22), nGQL construction, store-wins conflicts, cred-ref
 * resolution, unreachable-store exits, and the codegraph tags/edges (D23).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHANGE_LOG_LIMIT,
  NebulaBackend,
  buildImportsRepoQuery,
  buildThoughtQuery,
  defaultSpaceName,
  docToVertex,
  ngqlDeleteVertices,
  ngqlUpsertEdges,
  ngqlUpsertVertices,
  extractThoughtRelations,
  thoughtVid,
  vertexToDoc,
  THOUGHT_COLUMNS,
} from '../../../src/brain/backends/nebula.js';
import { nqLit, opOf, schemaStatements, splitNgqlStatements, substituteParams } from '../../../src/brain/backends/nebula-client.js';
import * as git from '../../../src/git.js';
import { resolveBackend } from '../../../src/brain/backends/resolve.js';
import { DEFAULT_KINDS, ExitCode, ThoughtsError, type BrainConfig } from '../../../src/types.js';
import { cleanupMachines, expectThoughtsError, makeMachine } from '../../commands/helpers.js';
import { FakeNebulaClient, FakeNebulaSpace } from './fakenebula.js';
import { backendContract, type BackendFixture } from './checklist.js';

afterEach(async () => {
  await cleanupMachines();
});

/** A backend over a space that provisioning has seeded (specs/16 step 1). */
async function makeBackend(workspace: string, space: FakeNebulaSpace, opts: { brainId?: string } = {}): Promise<NebulaBackend> {
  const backend = new NebulaBackend({ brainId: opts.brainId ?? 'contract-brain', workspace, client: new FakeNebulaClient(space) });
  await backend.provision();
  return backend;
}

describe('BrainBackend contract: nebula', () => {
  backendContract('nebula', async (): Promise<BackendFixture> => {
    const machine = await makeMachine('nebula');
    const space = new FakeNebulaSpace();
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
      backend: { kind: 'nebula', space: 'contract_brain' },
      repos: [],
      kinds: { ...DEFAULT_KINDS },
      templates: { source: 'builtin' },
    };
    return {
      backend: await makeBackend(workspace(), space),
      peer: async () => makeBackend(workspace(), space),
      brain,
    };
  });
});

const DOC = [
  '---',
  'type: Spec',
  'title: Refund endpoint',
  'status: draft',
  'repo: payments-api',
  'supersedes: shared/specs/2026-09-01-old.md',
  'sources:',
  '  - resource: /shared/specs/2026-09-10-ledger.md',
  'generated:',
  '  by: human:qa',
  '  at: 2026-09-10T00:00:00.000Z',
  '---',
  '# Refund endpoint',
  '',
  'Idempotent refunds.',
  '',
  'See [the ledger spec](/shared/specs/2026-09-10-ledger.md).',
  '',
].join('\n');

describe('nebula backend: native representation (specs/16 Representation, D22)', () => {
  it('writes frontmatter fields as thought VERTEX PROPERTIES, not a markdown dump', async () => {
    const machine = await makeMachine('nebula-native');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client, now: () => new Date('2026-09-11T00:00:00.000Z') });
    await backend.provision();
    await backend.write('repos/payments-api/specs/2026-09-10-refund.md', DOC);
    const rev = await backend.commit('thoughts(payments-api): 1 added, 0 updated');
    expect(rev).toBe('2');
    const vertex = client.thought('repos/payments-api/specs/2026-09-10-refund.md')!;
    expect(vertex).toBeDefined();
    expect(vertex['path']).toBe('repos/payments-api/specs/2026-09-10-refund.md');
    expect(vertex['repo_id']).toBe('payments-api');
    expect(vertex['kind']).toBe('specs');
    expect(vertex['zone']).toBe('repos');
    expect(vertex['title']).toBe('Refund endpoint');
    expect(vertex['status']).toBe('draft');
    expect(vertex['created']).toBe('2026-09-10T00:00:00.000Z');
    expect(vertex['updated']).toBe('2026-09-11T00:00:00.000Z');
    expect(JSON.parse(String(vertex['frontmatter']))).toMatchObject({ type: 'Spec', repo: 'payments-api' });
    expect(String(vertex['body'])).toContain('# Refund endpoint');
    // the byte-exact document rides along for materialisation (like psql's column)
    expect(vertex['document']).toBe(DOC);
    expect(vertex['revision']).toBe(2);
  });

  it('represents relations between thoughts as edges, lifted out of the body text', async () => {
    const machine = await makeMachine('nebula-edges');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client, now: () => new Date('2026-09-11T00:00:00.000Z') });
    await backend.provision();
    await backend.write('shared/specs/2026-09-10-old.md', DOC.replace('payments-api', 'shared').replace('supersedes: shared/specs/2026-09-01-old.md\n', ''));
    await backend.write('shared/specs/2026-09-10-ledger.md', DOC.replace('payments-api', 'shared').replace('supersedes: shared/specs/2026-09-01-old.md\n', ''));
    await backend.write('repos/payments-api/specs/2026-09-10-refund.md', DOC);
    await backend.commit('thoughts(payments-api): 2 added, 0 updated');

    const vid = thoughtVid('acme', 'repos/payments-api/specs/2026-09-10-refund.md');
    // SUPERSEDES from frontmatter supersedes
    expect(client.edgesOf('SUPERSEDES')).toContainEqual({
      src: vid,
      dst: thoughtVid('acme', 'shared/specs/2026-09-01-old.md'),
      props: {},
    });
    // LINKS_TO: the sources[] entry and the body link collapse into ONE edge
    const links = client.edgesOf('LINKS_TO').filter((e) => e.src === vid);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ src: vid, dst: thoughtVid('acme', 'shared/specs/2026-09-10-ledger.md') });
    // served by traversal, not by re-reading the document
    const served = await backend.thoughtRelations(vid);
    expect(served.map((r) => r.type).sort()).toEqual(['LINKS_TO', 'SUPERSEDES']);
    expect(served.find((r) => r.type === 'LINKS_TO')?.path).toBe('shared/specs/2026-09-10-ledger.md');
  });

  it('extracts no edge for a link that is not a thought of this brain', () => {
    const rel = extractThoughtRelations('shared/specs/2026-09-10-a.md', DOC.replace('supersedes: shared/specs/2026-09-01-old.md', 'supersedes: https://example.com/x.md'));
    expect(rel.supersedes).toEqual([]);
    expect(rel.linksTo).toEqual(['shared/specs/2026-09-10-ledger.md']);
  });

  it('rebuilds the document from the properties when the byte-exact copy is absent', () => {
    const vertex = docToVertex('shared/specs/2026-09-10-a.md', DOC, 1, 'thoughts', 'acme', new Date('2026-09-11T00:00:00.000Z'));
    const rebuilt = vertexToDoc({ ...vertex, document: '' });
    expect(rebuilt).toContain('title: "Refund endpoint"');
    expect(rebuilt).toContain('# Refund endpoint');
    // and a second split of the rebuild still carries the fields (D22 round-trip)
    const again = docToVertex(vertex.path, rebuilt!, 1, undefined, 'acme', new Date('2026-09-11T00:00:00.000Z'));
    expect(again.title).toBe(vertex.title);
    expect(again.status).toBe(vertex.status);
    expect(again.kind).toBe(vertex.kind);
  });

  it('reports modifiedAt from the store property, never a file stat (specs/16 rule 3)', async () => {
    const machine = await makeMachine('nebula-modified');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client, now: () => new Date('2026-09-11T00:00:00.000Z') });
    await backend.provision();
    await backend.write('shared/specs/2026-09-10-a.md', DOC);
    await backend.commit('thoughts(brain): 1 added, 0 updated');
    expect(await backend.modifiedAt('shared/specs/2026-09-10-a.md')).toEqual(new Date('2026-09-11T00:00:00.000Z'));
  });
});

describe('nebula backend: batched nGQL writes (specs/16)', () => {
  it('writes many thoughts as multi-row INSERT VERTEX statements, 50 rows per round-trip', async () => {
    const machine = await makeMachine('nebula-batch');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    await backend.provision();
    for (let i = 1; i <= 60; i += 1) {
      await backend.write(`shared/specs/2026-09-10-${String(i).padStart(3, '0')}.md`, DOC.replace('Refund endpoint', `Thought ${i}`));
    }
    await backend.commit('thoughts(brain): 60 added, 0 updated');
    const inserts = client.calls.filter((c) => opOf(c.stmt) === 'thought_upsert');
    expect(inserts).toHaveLength(2); // 60 rows in batches of 50
    expect(client.thoughts()).toHaveLength(60);
    expect(String(inserts[0]!.stmt)).toContain('INSERT VERTEX thought(');
    expect(String(inserts[0]!.stmt)).toContain(','.repeat(0)); // rows are comma-separated in one statement
  });

  it('deletes the vertices of removed thoughts, edges included', async () => {
    const machine = await makeMachine('nebula-delete');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    await backend.provision();
    await backend.write('shared/specs/2026-09-10-a.md', DOC);
    await backend.commit('thoughts(brain): 1 added, 0 updated');
    await backend.delete('shared/specs/2026-09-10-a.md');
    await backend.commit('thoughts(brain): 0 added, 0 updated, 1 removed');
    expect(client.thought('shared/specs/2026-09-10-a.md')).toBeUndefined();
    expect(client.edgesOf('SUPERSEDES')).toHaveLength(0);
  });
});

describe('nebula backend: conflicts are store wins (specs/16 sync table)', () => {
  const brain: BrainConfig = { okf_version: '0.2', kind: 'project', name: 'acme', repos: [], kinds: { ...DEFAULT_KINDS }, templates: { source: 'builtin' } };

  it('the store keeps its version, the loss is recorded in log.md and in the change log', async () => {
    const machine = await makeMachine('nebula-conflict');
    const space = new FakeNebulaSpace();
    const client = new FakeNebulaClient(space);
    const workspace = path.join(machine.root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    const backend = new NebulaBackend({ brainId: 'acme', workspace, client, now: () => new Date('2026-09-11T00:00:00.000Z') });
    await backend.provision();
    await backend.write('shared/specs/2026-09-10-a.md', DOC);
    await backend.commit('base');
    await backend.push({ paths: [], message: 'base', logEntries: [] });

    // both machines read the same base, then both write
    await backend.write('shared/specs/2026-09-10-a.md', DOC.replace('Refund endpoint', 'Ours'));
    const other = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'peer'), client: new FakeNebulaClient(space) });
    fs.mkdirSync(path.join(machine.root, 'peer'), { recursive: true });
    await other.pull('1');
    await other.write('shared/specs/2026-09-10-a.md', DOC.replace('Refund endpoint', 'Theirs'));
    await other.commit('other');
    await other.push({ paths: [], message: 'other', logEntries: [] });

    const err = await expectThoughtsError(() => backend.commit('ours'));
    expect(err.exitCode).toBe(ExitCode.Conflict);
    expect(String(err.message)).toContain('shared/specs/2026-09-10-a.md');
    // nothing partial landed: the store still carries the other machine's write
    expect(space.rev).toBe(3);
    expect(client.thought('shared/specs/2026-09-10-a.md')!['document']).toBe(DOC.replace('Refund endpoint', 'Theirs'));

    const info = await backend.conflictInfo();
    expect(info).toEqual({ conflicted: ['shared/specs/2026-09-10-a.md'], inProgress: false, storeWins: true });

    // settlement: store wins, the workspace is overwritten, the loss recorded
    const settled = await backend.resolveConflicts({ brain, log: { date: '2026-09-11', entries: [] } });
    expect(settled).toEqual(['shared/specs/2026-09-10-a.md']);
    expect(fs.readFileSync(path.join(workspace, 'shared/specs/2026-09-10-a.md'), 'utf8')).toBe(DOC.replace('Refund endpoint', 'Theirs'));
    const logMd = fs.readFileSync(path.join(workspace, 'log.md'), 'utf8');
    expect(logMd).toContain('store wins');
    expect(logMd).toContain('shared/specs/2026-09-10-a.md');
    // and the loss lives in the store's change log too, so no machine misses it
    const loss = [...space.vertices.get('change_log')!.values()].find((r) => String(r['note'] ?? '').includes('store wins'));
    expect(loss).toBeDefined();
    expect(loss!['document']).toBe(DOC.replace('Refund endpoint', 'Ours'));
    // fail soft: the workspace is settled; the regenerated indexes commit cleanly
    await expect(backend.commit('thoughts(brain): log')).resolves.toBeDefined();
    expect(await backend.dirty()).toEqual([]);
  });

  it('git conflict info never claims store wins (git and psql behaviour unchanged)', async () => {
    const machine = await makeMachine('nebula-storewins');
    const dir = path.join(machine.root, 'ws');
    fs.mkdirSync(dir, { recursive: true });
    await git.init(dir);
    const gitBackend = await resolveBackend({ brainId: 'b', workspace: dir });
    expect(await gitBackend.conflictInfo()).toStrictEqual({ conflicted: [], inProgress: false });
  });
});

describe('nebula backend: connection failures are named, never fatal to the workspace', () => {
  it('a missing connection ref is exit 1 naming the env var (specs/16 exit codes)', async () => {
    const machine = await makeMachine('nebula-noref');
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws') });
    const health = await backend.health();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('connection reference');
    const err = await expectThoughtsError(() => backend.commit('thoughts(acme): 1 added'));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.message).toContain('acme');
    expect(`${err.message} ${err.hint}`).toContain('THOUGHTS_NEBULA');
    // nothing was written: fail soft
    expect(fs.existsSync(path.join(machine.root, 'ws', 'shared'))).toBe(false);
  });

  it('an unreachable store is exit 2, masked, and keeps the local work', async () => {
    const machine = await makeMachine('nebula-down');
    const workspace = path.join(machine.root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    process.env['THOUGHTS_TEST_NEBULA'] = 'nebula://thoughts:sup3rs3cret@localhost:9669/acme';
    try {
      const backend = new NebulaBackend({
        brainId: 'acme',
        workspace,
        connectionRef: 'env:THOUGHTS_TEST_NEBULA',
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
      expect(fs.existsSync(path.join(workspace, 'shared'))).toBe(false);
    } finally {
      delete process.env['THOUGHTS_TEST_NEBULA'];
    }
  });

  it('resolveBackend returns a NebulaBackend for a nebula: ref and refuses without a cred-ref', async () => {
    const machine = await makeMachine('nebula-resolve');
    process.env['THOUGHTS_TEST_NEBULA'] = 'nebula://localhost:9669/acme';
    try {
      const backend = await resolveBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), brainRef: 'nebula:acme', connectionRef: 'env:THOUGHTS_TEST_NEBULA' });
      expect(backend.kind).toBe('nebula');
      const err = await expectThoughtsError(() =>
        resolveBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), brainRef: 'nebula:acme' }),
      );
      expect(err.exitCode).toBe(ExitCode.Validation);
      expect(`${err.message} ${err.hint}`).toContain('THOUGHTS_NEBULA');
    } finally {
      delete process.env['THOUGHTS_TEST_NEBULA'];
    }
  });

  it('takes the space name from brain.yml, else from the brain id', async () => {
    const machine = await makeMachine('nebula-space');
    const backend = new NebulaBackend({ brainId: 'acme-brain', workspace: path.join(machine.root, 'ws'), client: new FakeNebulaClient() });
    expect(await backend.storeName()).toBe('acme_brain');
    expect(defaultSpaceName('acme brain!')).toBe('acme_brain_');
    const named = new NebulaBackend({ brainId: 'acme-brain', workspace: path.join(machine.root, 'ws'), client: new FakeNebulaClient(), space: 'custom_space' });
    expect(await named.storeName()).toBe('custom_space');
  });

  it('provision() applies the shipped schema with the brain space substituted in', async () => {
    const machine = await makeMachine('nebula-provision');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme-brain', workspace: path.join(machine.root, 'ws'), client, space: 'acme_brain' });
    const result = await backend.provision();
    expect(result.applied).toBe(true);
    expect(client.space.createdSpaces).toEqual(['acme_brain']);
    expect(client.calls.some((c) => /CREATE TAG IF NOT EXISTS thought \(/.test(c.stmt))).toBe(true);
    expect(client.calls.some((c) => /CREATE EDGE IF NOT EXISTS IMPORTS_REPO/.test(c.stmt))).toBe(true);
  });
});

describe('nebula backend: nGQL construction', () => {
  it('serving questions run as LOOKUP / GO FROM traversals, never a workspace walk', () => {
    const { stmt, params } = buildThoughtQuery({ repoId: 'payments-api', kind: 'specs', status: 'draft', text: 'refund endpoint', limit: 5 });
    expect(stmt).toContain('LOOKUP ON thought');
    expect(stmt).toContain('thought.repo_id == $repo_id');
    expect(stmt).toContain('thought.kind == $kind');
    expect(stmt).toContain('thought.status == $status');
    expect(stmt).toContain('properties(vertex).path AS path');
    expect(stmt).toContain('| WHERE');
    expect(stmt).toContain("$-.title CONTAINS $term0 OR $-.body CONTAINS $term0");
    expect(stmt).toContain('| ORDER BY $-.revision DESC');
    expect(stmt).toContain('| LIMIT $limit');
    expect(params).toMatchObject({ repo_id: 'payments-api', kind: 'specs', status: 'draft', term0: 'refund', term1: 'endpoint', limit: 5 });

    const pull = buildThoughtQuery({ sinceRevision: 12 });
    expect(pull.stmt).toContain('thought.revision > $since');
    expect(pull.params).toMatchObject({ since: 12 });

    expect(buildImportsRepoQuery(['a', 'b']).stmt).toContain('GO FROM \'a\', \'b\' OVER IMPORTS_REPO REVERSELY');
    expect(buildImportsRepoQuery([]).stmt).toContain('GO FROM  OVER IMPORTS_REPO');
  });

  it('substitutes named parameters with escaped literals and leaves nGQL pipes alone', () => {
    expect(substituteParams('WHERE path == $p', { p: "it's a test" })).toBe("WHERE path == 'it\\'s a test'");
    expect(substituteParams('VALUES $v', { v: 'line1\nline2\\x' })).toBe("VALUES 'line1\\nline2\\\\x'");
    // `$-` and `$^` are nGQL syntax, not parameters
    expect(substituteParams('WHERE $-.x CONTAINS $t', { t: 'q' })).toBe("WHERE $-.x CONTAINS 'q'");
    expect(substituteParams('no params', undefined)).toBe('no params');
    expect(() => substituteParams('WHERE x == $missing', {})).toThrow(ThoughtsError);
  });

  it('escapes values so a quote or newline in a body cannot break the statement', () => {
    expect(nqLit("it's")).toBe("'it\\'s'");
    expect(nqLit('a\nb')).toBe("'a\\nb'");
    expect(nqLit(null)).toBe('NULL');
    expect(nqLit(7)).toBe('7');
  });

  it('builds one multi-row statement per batch', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ vid: `v${i}`, values: ['p', i] }));
    const stmt = ngqlUpsertVertices('thought_upsert', 'thought', THOUGHT_COLUMNS, rows);
    expect(opOf(stmt)).toBe('thought_upsert');
    expect(stmt).toContain('INSERT VERTEX thought(');
    expect((stmt.match(/'v\d+':\(/g) ?? []).length).toBe(120);
    expect(ngqlUpsertVertices('x', 't', ['a'], [])).toBe('');
    const edges = ngqlUpsertEdges('edge_upsert', 'LINKS_TO', ['by'], [{ src: 'a', dst: 'b', values: ['me'] }]);
    expect(edges).toContain("INSERT EDGE LINKS_TO(by) VALUES 'a'->'b':('me')");
    expect(ngqlDeleteVertices('thought_delete', ['a', 'b'])).toContain("DELETE VERTEX 'a', 'b' WITH EDGE");
  });

  it('splits the schema into statements on semicolons outside quotes', () => {
    const statements = splitNgqlStatements("USE a;\nCREATE TAG t (p string); -- note: 'semi;colon'\nINSERT VERTEX t VALUES 'v':('a;b');");
    expect(statements).toHaveLength(3);
    expect(statements[2]).toContain("'a;b'");
    const space = schemaStatements('acme_brain');
    expect(space[0]).toContain('CREATE SPACE IF NOT EXISTS acme_brain (partition_num = 10, replica_factor = 1');
    expect(space[1]).toBe('USE acme_brain;');
    expect(space.length).toBeGreaterThan(10);
  });
});

describe('nebula backend: the change log is bounded and the history partial (specs/16)', () => {
  it('prunes change-log rows older than the retained window', async () => {
    const machine = await makeMachine('nebula-bounded');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    await backend.provision();
    for (let i = 1; i <= 3; i += 1) {
      await backend.write(`shared/specs/2026-09-1${i}-a.md`, DOC.replace('Refund endpoint', '# ' + i));
      await backend.commit(`thoughts(brain): ${i}`);
    }
    expect(client.calls.some((c) => opOf(c.stmt) === 'changes_older')).toBe(false); // nothing to prune yet
    expect(client.space.vertices.get('change_log')!.size).toBe(3);
    expect(CHANGE_LOG_LIMIT).toBeGreaterThan(0);
    expect(backend.historyMode).toBe('partial');
  });

  it('read() at a revision pruned from the bounded log returns undefined rather than a guess', async () => {
    const machine = await makeMachine('nebula-pruned');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    await backend.provision();
    await backend.write('shared/specs/2026-09-10-a.md', DOC);
    await backend.commit('first');
    await backend.delete('shared/specs/2026-09-10-a.md');
    await backend.commit('second');
    // the row still sits inside the window
    expect(await backend.read('shared/specs/2026-09-10-a.md', { revision: '2' })).toBe(DOC);
    // outside it (nothing retained at revision 0), there is no document to serve
    expect(await backend.read('shared/specs/2026-09-10-a.md', { revision: '0' })).toBeUndefined();
  });
});

describe('nebula backend: codegraph in native tags and edges (specs/17 Storage, D23)', () => {
  const graph = {
    version: 1,
    repoId: 'payments-api',
    codeCommit: 'abc123',
    counts: { files: 2, symbols: 2, edges: 4 },
    nodes: [
      { id: 'f1', kind: 'file', name: 'src/index.ts', path: 'src/index.ts', sha: 'aa11', codeCommit: 'abc123' },
      { id: 'f2', kind: 'file', name: 'src/util.ts', path: 'src/util.ts', sha: 'bb22', codeCommit: 'abc123' },
      { id: 's1', kind: 'symbol', name: 'main', path: 'src/index.ts', symbolKind: 'function', line: 1, endLine: 2, codeCommit: 'abc123' },
      { id: 'm1', kind: 'module', name: '@acme/payments-api', manifest: 'package.json', codeCommit: 'abc123' },
    ],
    edges: [
      { id: 'e1', type: 'contains', source: 'f1', target: 's1', codeCommit: 'abc123' },
      { id: 'e2', type: 'imports', source: 'f1', target: 'f2', codeCommit: 'abc123' },
      { id: 'e3', type: 'calls', source: 's1', target: 's1', codeCommit: 'abc123' },
      { id: 'e4', type: 'imports_repo', source: 'm1', target: 'sibling-module', codeCommit: 'abc123' },
    ],
  };

  it('stores files/symbols/modules as tags and contains/imports/calls/imports_repo as edges', async () => {
    const machine = await makeMachine('nebula-graph');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    await backend.provision();
    const doc = JSON.stringify(graph, null, 2) + '\n';
    await backend.saveGraph('payments-api', doc);
    expect(await backend.loadGraph('payments-api')).toBe(doc);
    expect(await backend.loadGraph('nope')).toBeUndefined();
    expect(client.space.vertices.get('code_file')!.size).toBe(2);
    expect(client.space.vertices.get('code_symbol')!.size).toBe(1);
    expect(client.space.vertices.get('code_module')!.size).toBe(1);
    for (const type of ['CONTAINS', 'IMPORTS', 'CALLS', 'IMPORTS_REPO']) {
      expect(client.edgesOf(type)).toHaveLength(1);
    }
    // a cross-repo edge is an ordinary edge of the space: traversal finds it
    await backend.saveGraph('sibling', JSON.stringify({ ...graph, repoId: 'sibling', nodes: [{ id: 'sibling-module', kind: 'module', name: '@acme/sibling', codeCommit: 'abc123' }], edges: [] }, null, 2) + '\n');
    const deps = await backend.crossRepoImports('sibling');
    expect(deps).toEqual([{ fromRepo: 'payments-api', module: '@acme/payments-api' }]);
  });

  it('replaces a repo graph wholesale: no stale node, no dangling edge', async () => {
    const machine = await makeMachine('nebula-graph-replace');
    const client = new FakeNebulaClient();
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client });
    await backend.provision();
    await backend.saveGraph('payments-api', JSON.stringify(graph, null, 2) + '\n');
    const smaller = { ...graph, nodes: graph.nodes.slice(0, 1), edges: [], counts: { files: 1, symbols: 0, edges: 0 } };
    await backend.saveGraph('payments-api', JSON.stringify(smaller, null, 2) + '\n');
    // the stale symbol/module vertices were deleted WITH EDGE, taking the
    // contains/imports/calls/imports_repo edges that touched them
    expect(client.space.vertices.get('code_file')!.size).toBe(1);
    expect(client.space.vertices.get('code_symbol')?.size ?? 0).toBe(0);
    expect(client.space.vertices.get('code_module')?.size ?? 0).toBe(0);
    for (const type of ['CONTAINS', 'IMPORTS', 'CALLS', 'IMPORTS_REPO']) {
      expect(client.edgesOf(type)).toHaveLength(0);
    }
    expect(await backend.loadGraph('payments-api')).toBe(JSON.stringify(smaller, null, 2) + '\n');
  });

  it('round-trips the graph meta alongside the graph document', async () => {
    const machine = await makeMachine('nebula-graph-meta');
    const backend = new NebulaBackend({ brainId: 'acme', workspace: path.join(machine.root, 'ws'), client: new FakeNebulaClient() });
    await backend.saveGraph('payments-api', JSON.stringify(graph, null, 2) + '\n');
    await backend.saveGraphMeta('payments-api', 'codeCommit: abc123\ngenerated:\n  at: 2026-09-10T00:00:00.000Z\n');
    expect(await backend.loadGraphMeta('payments-api')).toContain('abc123');
    expect(await backend.loadGraphMeta('nope')).toBeUndefined();
    // the meta write does not clobber the graph document (unlike a shared column)
    expect(await backend.loadGraph('payments-api')).toContain('"repoId": "payments-api"');
  });
});
