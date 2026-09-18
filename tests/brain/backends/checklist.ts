/**
 * The shared BrainBackend contract checklist (specs/16). Every backend runs
 * the same suite: tests/brain/backends/memory.test.ts against the in-memory
 * reference, git.test.ts against GitBackend over a bare repo.
 */
import { expect, it, beforeEach } from 'vitest';
import { expectThoughtsError } from '../../commands/helpers.js';
import type { BrainBackend } from '../../../src/brain/backends/types.js';
import { ExitCode, type BrainConfig, type LogEntry } from '../../../src/types.js';

export interface BackendFixture {
  backend: BrainBackend;
  /** A second backend over the same store, with its own fresh workspace. */
  peer(): Promise<BrainBackend>;
  brain: BrainConfig;
}

const DOC_A = ['---', 'type: Spec', 'title: A', 'status: draft', 'repo: demo', 'generated:', '  by: human:qa', '  at: 2026-09-10T00:00:00Z', '---', '# A', ''].join('\n');
const DOC_B = DOC_A.replace('# A', '# B');
const DOC_C = DOC_A.replace('# A', '# C');
const PATH = 'shared/specs/2026-09-10-a.md';

function logEntries(path: string): LogEntry[] {
  return [{ change: 'added', path: '/' + path, title: 'A' }];
}

/** Register the contract suite for one backend. */
export function backendContract(name: string, makeFixture: () => Promise<BackendFixture>): void {
  let fix: BackendFixture;
  beforeEach(async () => {
    fix = await makeFixture();
  });

  it(`${name}: health() reports the store`, async () => {
    const health = await fix.backend.health();
    expect(health.ok).toBe(true);
  });

  it(`${name}: write/read/delete round-trips through the workspace`, async () => {
    const b = fix.backend;
    await b.write(PATH, DOC_A);
    expect(await b.read(PATH)).toBe(DOC_A);
    await b.delete(PATH);
    expect(await b.read(PATH)).toBeUndefined();
  });

  it(`${name}: listThoughts() lists workspace markdown`, async () => {
    const b = fix.backend;
    await b.write(PATH, DOC_A);
    await b.write('repos/demo/plans/2026-09-10-p.md', DOC_B);
    const listed = await b.listThoughts();
    expect(listed).toContain(PATH);
    expect(listed).toContain('repos/demo/plans/2026-09-10-p.md');
    expect(listed).toEqual([...listed].sort());
  });

  it(`${name}: dirty() tracks workspace changes until they are committed`, async () => {
    const b = fix.backend;
    expect(await b.dirty()).toEqual([]);
    await b.write(PATH, DOC_A);
    expect((await b.dirty()).map((c) => c.path)).toEqual([PATH]);
    expect((await b.dirty())[0]).toMatchObject({ deleted: false });
    await b.commit('thoughts(demo): 1 added, 0 updated');
    expect(await b.dirty()).toEqual([]);
  });

  it(`${name}: revision() changes on commit and messageOf() reads it back`, async () => {
    const b = fix.backend;
    const before = await b.revision();
    await b.write(PATH, DOC_A);
    const after = await b.commit('thoughts(demo): 1 added, 0 updated');
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(await b.messageOf(after!)).toBe('thoughts(demo): 1 added, 0 updated');
    expect(await b.revision()).toBe(after);
  });

  it(`${name}: commit() with nothing dirty commits nothing`, async () => {
    expect(await fix.backend.commit('nothing')).toBeUndefined();
  });

  it(`${name}: push() delivers the local revision to the store`, async () => {
    const b = fix.backend;
    await b.write(PATH, DOC_A);
    const rev = await b.commit('thoughts(demo): 1 added, 0 updated');
    const result = await b.push({ paths: [PATH], message: 'thoughts(demo): 1 added, 0 updated', logEntries: logEntries(PATH) });
    expect(result.pushed).toBe(true);
    expect(result.revision).toBeDefined();
    expect(rev).toBeDefined();
  });

  it(`${name}: pull() returns the changes another machine wrote`, async () => {
    const b = fix.backend;
    const other = await fix.peer();
    const lastRev = await other.revision();
    await b.write(PATH, DOC_A);
    await b.commit('thoughts(demo): 1 added, 0 updated');
    await b.push({ paths: [PATH], message: 'x', logEntries: [] });
    const changes = await other.pull(lastRev);
    expect(changes).toContainEqual({ path: PATH, change: 'added' });
    expect(await other.read(PATH)).toBe(DOC_A);
  });

  it(`${name}: read() at a revision returns the older document`, async () => {
    const b = fix.backend;
    await b.write(PATH, DOC_A);
    const rev1 = await b.commit('first');
    await b.write(PATH, DOC_B);
    await b.commit('second');
    expect(await b.read(PATH, { revision: rev1! })).toBe(DOC_A);
    expect(await b.read(PATH, { revision: 'HEAD' })).toBe(DOC_B);
  });

  it(`${name}: the same path written on two machines conflicts with exit 4 naming the path`, async () => {
    const b = fix.backend;
    const ctx = { brain: fix.brain, log: { date: '2026-09-10', entries: [] as LogEntry[] } };
    // A base revision both machines agree on.
    await b.write(PATH, DOC_A);
    await b.commit('base');
    await b.push({ paths: [PATH], message: 'base', logEntries: [] });

    // This machine writes first, then the other machine lands its own write.
    await b.write(PATH, DOC_C);
    const other = await fix.peer();
    await other.write(PATH, DOC_B);
    await other.commit('thoughts(other): 1 updated');
    await other.push({ paths: [PATH], message: 'other', logEntries: [] });

    // git: the local commit is fine and the conflict surfaces at pull;
    // memory/psql: the base-revision mismatch aborts the commit itself
    // (specs/16 "Sync and conflict semantics").
    let err: unknown;
    try {
      await b.commit('thoughts(demo): 1 updated');
      err = await expectThoughtsError(() => b.pull(undefined, ctx));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const e = err as { exitCode?: unknown; message?: unknown };
    expect(e.exitCode).toBe(ExitCode.Conflict);
    expect(String(e.message)).toContain(PATH);

    const info = await b.conflictInfo();
    expect(info.conflicted).toEqual([PATH]);
    expect(await b.resolveConflicts(ctx)).toEqual([PATH]);
  });

  it(`${name}: saveGraph()/loadGraph() round-trip the generated graph document`, async () => {
    const b = fix.backend;
    expect(await b.loadGraph('demo')).toBeUndefined();
    await b.saveGraph('demo', '{"nodes":[],"edges":[]}');
    expect(await b.loadGraph('demo')).toBe('{"nodes":[],"edges":[]}');
  });
}
