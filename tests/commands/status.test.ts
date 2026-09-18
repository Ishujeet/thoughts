/** `thoughts status` (specs/04, milestone-2 scope: no integrations, no codegraph). */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGlobalConfig, saveGlobalConfig } from '../../src/brain/config.js';
import { parseFrontmatter, serializeThought } from '../../src/brain/okf.js';
import { runInit } from '../../src/commands/init.js';
import { runNew } from '../../src/commands/new.js';
import { runStatus, type StatusResult } from '../../src/commands/status.js';
import { runSync } from '../../src/commands/sync.js';
import {
  capture,
  cleanupMachines,
  makeBareBrain,
  makeCodeRepo,
  makeMachine,
  write,
  type Captured,
  type Machine,
} from './helpers.js';

interface Teammate {
  machine: Machine;
  repo: string;
  brain: string;
}

let cap: Captured;
let bare: string;
beforeEach(async () => {
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

/** A teammate on its own machine, with `repoId` attached to the shared bare brain. */
async function teammate(label: string, repoId: string): Promise<Teammate> {
  const machine = await makeMachine(label);
  const repo = await makeCodeRepo(path.join(machine.root, repoId));
  const r = await runInit({ yes: true, brain: bare }, repo);
  return { machine, repo, brain: r.brainRoot };
}

async function setup(): Promise<[Teammate, Teammate]> {
  const host = await makeMachine('remote');
  bare = await makeBareBrain(host.root);
  const a = await teammate('a', 'payments-api');
  const b = await teammate('b', 'orders-service');
  return [a, b];
}

/** Patch frontmatter of a thought file in place, preserving unknown keys. */
function editFrontmatter(absPath: string, patch: Record<string, unknown>): void {
  const parsed = parseFrontmatter(fs.readFileSync(absPath, 'utf8'));
  Object.assign(parsed.frontmatter, patch);
  fs.writeFileSync(absPath, serializeThought(parsed.frontmatter, parsed.body));
}

/** Backdate a file's mtime by `days`. */
function ageFile(absPath: string, days: number): void {
  const t = new Date(Date.now() - days * 86_400_000);
  fs.utimesSync(absPath, t, t);
}

function allRows(res: StatusResult): StatusResult['stale'] {
  return [...res.groups.flatMap((g) => g.rows), ...res.stale];
}

describe('status: in flight', () => {
  it('an empty brain renders nothing to do', async () => {
    const [a] = await setup();
    a.machine.use();
    const res = await runStatus({}, a.repo);
    expect(res.groups).toEqual([]);
    expect(res.stale).toEqual([]);
    expect(res.unsynced).toEqual([]);
    expect(cap.stdout.join('')).toContain('nothing to do');
    // One integration warning per specs/04, since specs/10 is unimplemented.
    expect(res.warnings.join('\n')).toContain('integration state');
    expect(cap.stderr.join('').match(/integration state/g)).toHaveLength(1);
  });

  it('a draft thought appears in its repo group, current repo first and marked (you)', async () => {
    const [a] = await setup();
    a.machine.use();
    const t = await runNew('spec', 'Refund endpoint', {}, a.repo);
    const res = await runStatus({}, a.repo);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ group: 'repos/payments-api', current: true });
    expect(res.groups[0]!.rows[0]).toMatchObject({ path: t.path, kind: 'specs', title: 'Refund endpoint', status: 'draft' });
    const printed = cap.stdout.join('');
    expect(printed).toContain('payments-api (you');
    expect(printed).toContain('Refund endpoint');
    expect(printed).toContain('draft');
  });

  it('a stable, old thought is not in flight, but stays visible as an unsynced edit', async () => {
    const [a] = await setup();
    a.machine.use();
    const t = await runNew('spec', 'Old design', {}, a.repo);
    editFrontmatter(t.absPath, { status: 'stable' });
    ageFile(t.absPath, 30);
    const res = await runStatus({}, a.repo);
    expect(allRows(res)).toEqual([]);
    // Not committed yet: the local, unsynced section still asks for a sync.
    expect(res.unsynced).toEqual([t.path.slice(1)]);
    const printed = cap.stdout.join('');
    expect(printed).toContain('unsynced: specs/' + path.basename(t.path));
    expect(printed).not.toContain('nothing to do');
  });

  it('a stable thought modified within --since is in flight, and --since filters it', async () => {
    const [a] = await setup();
    a.machine.use();
    const t = await runNew('spec', 'Recent edit', {}, a.repo);
    editFrontmatter(t.absPath, { status: 'stable' });
    ageFile(t.absPath, 3);
    const res14 = await runStatus({}, a.repo); // default 14d
    expect(res14.groups[0]!.rows.map((r) => r.title)).toEqual(['Recent edit']);
    expect(res14.groups[0]!.rows[0]!.age).toBe('3d');
    const res1 = await runStatus({ since: '1d' }, a.repo);
    expect(allRows(res1)).toEqual([]);
  });

  it('a thought with stale_after in the past lands in the stale bucket, not its repo group', async () => {
    const [a] = await setup();
    a.machine.use();
    const t = await runNew('spec', 'SMS provider', {}, a.repo);
    editFrontmatter(t.absPath, { stale_after: '2026-06-01' });
    const res = await runStatus({}, a.repo);
    // Stale is a separate bucket: no row in the repo group, even though the
    // thought is an uncommitted draft.
    expect(res.groups[0]!.rows).toEqual([]);
    expect(res.groups[0]!.unsynced).toEqual([t.path.slice(1)]);
    expect(res.stale).toHaveLength(1);
    expect(res.stale[0]).toMatchObject({ path: t.path, stale: true, staleAfter: '2026-06-01' });
    const printed = cap.stdout.join('');
    expect(printed).toContain('stale (1)');
    expect(printed).toContain('stale_after 2026-06-01');
  });

  it('--kind filters by kind, repeatable or comma-separated', async () => {
    const [a, b] = await setup();
    a.machine.use();
    await runNew('spec', 'A spec', {}, a.repo);
    await runNew('plan', 'A plan', {}, a.repo);
    await runSync({}, a.repo);
    b.machine.use();
    await runSync({}, b.repo);
    const resOne = await runStatus({ kind: ['specs'] }, b.repo);
    expect(allRows(resOne).map((r) => r.kind)).toEqual(['specs']);
    const resTwo = await runStatus({ kind: ['specs,plans'] }, b.repo);
    expect(allRows(resTwo).map((r) => r.kind).sort()).toEqual(['plans', 'specs']);
  });

  it('--repo limits the report to one repo', async () => {
    const [a, b] = await setup();
    a.machine.use();
    await runNew('spec', 'Payments spec', {}, a.repo);
    await runSync({}, a.repo);
    b.machine.use();
    await runSync({}, b.repo);
    const res = await runStatus({ repo: 'payments-api' }, b.repo);
    expect(res.groups.map((g) => g.group)).toEqual(['repos/payments-api']);
    expect(res.groups[0]!.current).toBe(false);
  });

  it('--mine keeps only my thoughts', async () => {
    const [a] = await setup();
    a.machine.use();
    await runNew('spec', 'Alice thing', { set: ['author=human:alice'] }, a.repo);
    await runNew('spec', 'Bob thing', { set: ['author=human:bob'] }, a.repo);
    const g = await loadGlobalConfig();
    g.user_id = 'alice';
    await saveGlobalConfig(g);
    const res = await runStatus({ mine: true }, a.repo);
    expect(allRows(res).map((r) => r.title)).toEqual(['Alice thing']);
    const resAll = await runStatus({}, a.repo);
    expect(allRows(resAll)).toHaveLength(2);
  });

  it('groups are ordered current repo first, then the other repos', async () => {
    const [a, b] = await setup();
    a.machine.use();
    await runNew('spec', 'Payments spec', {}, a.repo);
    await runSync({}, a.repo);
    b.machine.use();
    await runSync({}, b.repo);
    await runNew('spec', 'Orders spec', {}, b.repo);
    const res = await runStatus({}, b.repo);
    expect(res.groups.map((g) => g.group)).toEqual(['repos/orders-service', 'repos/payments-api']);
    expect(res.groups[0]!.current).toBe(true);
    expect(res.groups[1]!.current).toBe(false);
  });
});

describe('status: local, unsynced', () => {
  it('uncommitted brain changes appear in the local, unsynced section', async () => {
    const [a, b] = await setup();
    a.machine.use();
    const t = await runNew('spec', 'Refund endpoint', {}, a.repo);
    await runSync({}, a.repo);
    b.machine.use();
    await runSync({}, b.repo);
    a.machine.use();
    fs.appendFileSync(path.join(a.brain, t.path.slice(1)), '\nExtra note.\n');
    const res = await runStatus({}, a.repo);
    expect(res.unsynced).toEqual([t.path.slice(1)]);
    expect(res.groups[0]!.unsynced).toEqual([t.path.slice(1)]);
    expect(cap.stdout.join('')).toContain('unsynced: specs/' + path.basename(t.path));
  });

  it('warns about edits under another repo’s brain directory', async () => {
    const [a, b] = await setup();
    a.machine.use();
    await runNew('spec', 'Payments spec', {}, a.repo);
    await runSync({}, a.repo);
    b.machine.use();
    const tb = await runNew('spec', 'Orders spec', {}, b.repo);
    await runSync({}, b.repo);
    a.machine.use();
    await runSync({}, a.repo);
    fs.appendFileSync(path.join(a.brain, tb.path.slice(1)), '\nMore.\n');
    const res = await runStatus({}, a.repo);
    expect(res.warnings.join('\n')).toContain('orders-service');
  });
});

describe('status: --json', () => {
  it('round-trips every human-visible field', async () => {
    const [a] = await setup();
    a.machine.use();
    const draft = await runNew('spec', 'Refund endpoint', {}, a.repo);
    const old = await runNew('plan', 'SMS provider', {}, a.repo);
    editFrontmatter(old.absPath, { stale_after: '2026-06-01' });
    write(path.join(a.brain, 'repos/payments-api/research/2026-09-08-webhooks.md'), '---\ntitle: Webhooks\nstatus: draft\nrepo: payments-api\ngenerated:\n  by: human:qa\n  at: "2026-09-08T00:00:00Z"\n---\n');
    // Only the status run's stdout: init's step table went out earlier.
    cap.restore();
    cap = capture();
    const res = await runStatus({ json: true }, a.repo);
    // With --json stdout is exactly one JSON document.
    expect(cap.stdout.join('').trim().startsWith('{')).toBe(true);
    const printed = JSON.parse(cap.stdout.join('')) as StatusResult;
    expect(printed.brainName).toBe(res.brainName);
    const rows = [
      ...printed.groups.flatMap((g) => g.rows),
      ...printed.stale,
    ];
    expect(rows.map((r) => r.path).sort()).toEqual([draft.path, old.path, '/repos/payments-api/research/2026-09-08-webhooks.md'].sort());
    for (const r of rows) {
      expect(typeof r.group).toBe('string');
      expect(typeof r.kind).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.status).toBe('string');
      expect(typeof r.age).toBe('string');
      expect(typeof r.modifiedAt).toBe('string');
      expect(typeof r.stale).toBe('boolean');
    }
    const staleRow = rows.find((r) => r.stale)!;
    expect(staleRow.staleAfter).toBe('2026-06-01');
    expect(staleRow.path).toBe(old.path);
    expect(rows.find((r) => r.title === 'Refund endpoint')!.staleAfter).toBeUndefined();
  });
});
