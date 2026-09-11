/** `thoughts sync` (specs/03 acceptance criteria) with a local bare remote and two "machines". */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { runNew } from '../../src/commands/new.js';
import { commitMessage, runSync } from '../../src/commands/sync.js';
import * as git from '../../src/git.js';
import { ExitCode, SecretFoundError } from '../../src/types.js';
import {
  capture,
  cleanupMachines,
  expectThoughtsError,
  fakeStripeKey,
  makeBareBrain,
  makeCodeRepo,
  makeMachine,
  read,
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

describe('commitMessage', () => {
  it('follows the specs/03 format; --message overrides the first line only', () => {
    const entries = [
      { change: 'added' as const, path: '/repos/payments-api/specs/2026-09-08-refund-endpoint.md', title: 'x' },
      { change: 'updated' as const, path: '/shared/decisions/2026-09-01-idempotency-keys.md', title: 'y' },
    ];
    expect(commitMessage('payments-api', entries)).toBe(
      'thoughts(payments-api): 1 added, 1 updated\n\n- added   repos/payments-api/specs/2026-09-08-refund-endpoint.md\n- updated shared/decisions/2026-09-01-idempotency-keys.md',
    );
    expect(commitMessage('payments-api', entries, 'custom')).toMatch(/^custom\n\n- added/);
    expect(commitMessage('brain', [])).toBe('thoughts(brain): 0 added, 0 updated');
  });
});

describe('sync: two clones', () => {
  it('both end with both specs and identical index.md', async () => {
    const [a, b] = await setup();
    a.machine.use();
    const specA = await runNew('spec', 'Refund endpoint', {}, a.repo);
    const sa = await runSync({}, a.repo);
    expect(sa.committed).toBeDefined();
    expect(sa.commitMessage).toBe(`thoughts(payments-api): 1 added, 0 updated\n\n- added   ${specA.path.slice(1)}`);
    expect(sa.entries[0]).toMatchObject({ change: 'added', path: specA.path, title: 'Refund endpoint' });
    expect(sa.pushed).toBe(true);

    b.machine.use();
    const specB = await runNew('spec', 'Order events', {}, b.repo);
    const sb = await runSync({}, b.repo);
    expect(sb.pushed).toBe(true);
    // A's spec arrived and is reported grouped by repo.
    expect(sb.incoming).toEqual([{ group: 'repos/payments-api', change: 'added', path: specA.path, kind: 'specs', title: 'Refund endpoint' }]);
    expect(cap.stdout.join('')).toContain('repos/payments-api');

    a.machine.use();
    const sa2 = await runSync({}, a.repo);
    // A regenerated its index before pulling (spec-fixed order); that index-only
    // commit is dropped by the rebase because B's push already carried it.
    expect(sa2.committed).toBeUndefined();
    expect(sa2.pulled).toBe(true);
    expect(sa2.incoming.map((i) => i.path)).toEqual([specB.path]);

    for (const t of [a, b]) {
      expect(fs.existsSync(path.join(t.brain, specA.path.slice(1)))).toBe(true);
      expect(fs.existsSync(path.join(t.brain, specB.path.slice(1)))).toBe(true);
      expect((await git.statusPorcelain(t.brain)).length).toBe(0);
    }
    for (const rel of ['index.md', 'log.md', 'repos/payments-api/index.md', 'repos/orders-service/index.md']) {
      expect(read(path.join(a.brain, rel))).toBe(read(path.join(b.brain, rel)));
    }
    expect(read(path.join(a.brain, 'repos/payments-api/index.md'))).toContain('Refund endpoint');
    expect(read(path.join(a.brain, 'log.md'))).toContain('Order events');
    expect(read(path.join(a.brain, 'log.md'))).toContain('Refund endpoint');
    expect(await git.headSha(a.brain)).toBe(await git.headSha(b.brain));
  });

  it('conflict in a shared decision → exit 4 naming the file; after git rebase --continue, sync finishes', async () => {
    const [a, b] = await setup();
    a.machine.use();
    const dec = await runNew('decision', 'Retry budget', { shared: true }, a.repo);
    await runSync({}, a.repo);
    b.machine.use();
    await runSync({}, b.repo);

    const rel = dec.path.slice(1);
    a.machine.use();
    write(path.join(a.brain, rel), read(path.join(a.brain, rel)).replace('## Decision\n', '## Decision\n\nWe will use A.\n'));
    await runSync({}, a.repo);

    b.machine.use();
    write(path.join(b.brain, rel), read(path.join(b.brain, rel)).replace('## Decision\n', '## Decision\n\nWe will use B.\n'));
    const e = await expectThoughtsError(() => runSync({}, b.repo));
    expect(e.exitCode).toBe(ExitCode.Conflict);
    expect(e.message).toContain(rel);
    expect(e.message).not.toContain('log.md');
    expect(e.hint).toBe('resolve with git, then run: thoughts sync');
    expect(await git.isRebaseInProgress(b.brain)).toBe(true);
    expect(await git.conflictedFiles(b.brain)).toEqual([rel]);
    expect(read(path.join(b.brain, rel))).toContain('<<<<<<<');

    // The user resolves with git.
    write(path.join(b.brain, rel), read(path.join(b.brain, rel)).replace(/<<<<<<<[^\n]*\n[\s\S]*?=======\n([\s\S]*?)>>>>>>>[^\n]*\n/, '$1'));
    await git.git(['add', '--', rel], { cwd: b.brain });
    await git.git(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: b.brain });
    const done = await runSync({}, b.repo);
    expect(done.pushed).toBe(true);
    expect(await git.isRebaseInProgress(b.brain)).toBe(false);
    a.machine.use();
    await runSync({}, a.repo);
    expect(read(path.join(a.brain, rel))).toContain('We will use B.');
    expect(await git.headSha(a.brain)).toBe(await git.headSha(b.brain));
  });

  it('a sync while a rebase is still conflicted reports exit 4 again, never retries silently', async () => {
    const [a, b] = await setup();
    a.machine.use();
    const dec = await runNew('decision', 'Naming', { shared: true }, a.repo);
    await runSync({}, a.repo);
    b.machine.use();
    await runSync({}, b.repo);
    const rel = dec.path.slice(1);
    a.machine.use();
    write(path.join(a.brain, rel), read(path.join(a.brain, rel)) + '\nA\n');
    await runSync({}, a.repo);
    b.machine.use();
    write(path.join(b.brain, rel), read(path.join(b.brain, rel)) + '\nB\n');
    expect((await expectThoughtsError(() => runSync({}, b.repo))).exitCode).toBe(ExitCode.Conflict);
    expect((await expectThoughtsError(() => runSync({}, b.repo))).exitCode).toBe(ExitCode.Conflict);
  });
});

describe('sync: offline and secrets', () => {
  it('offline → local commit succeeds, exit 2; next online sync pushes it', async () => {
    const [a] = await setup();
    a.machine.use();
    await git.git(['remote', 'set-url', 'origin', path.join(a.machine.root, 'gone', 'brain.git')], { cwd: a.brain });
    const spec = await runNew('spec', 'Offline spec', {}, a.repo);
    const e = await expectThoughtsError(() => runSync({}, a.repo));
    expect(e.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect(e.message).toMatch(/unreachable|failed/);
    expect((await git.statusPorcelain(a.brain)).length).toBe(0);
    const head = await git.git(['log', '-1', '--format=%s'], { cwd: a.brain });
    expect(head.stdout.trim()).toBe('thoughts(payments-api): 1 added, 0 updated');
    expect((await git.git(['log', '--format=%s'], { cwd: bare })).stdout).not.toContain('1 added');

    await git.git(['remote', 'set-url', 'origin', bare], { cwd: a.brain });
    const s = await runSync({}, a.repo);
    expect(s.committed).toBeUndefined();
    expect(s.pushed).toBe(true);
    expect((await git.git(['log', '--format=%s'], { cwd: bare })).stdout).toContain('1 added');
    expect((await git.git(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: bare })).stdout).toContain(spec.path.slice(1));
  });

  it('a live-looking API key → exit 7, brain git status unchanged, key masked', async () => {
    const [a] = await setup();
    a.machine.use();
    const spec = await runNew('research', 'Stripe webhooks', {}, a.repo);
    const key = fakeStripeKey();
    const abs = path.join(a.brain, spec.path.slice(1));
    write(abs, read(abs) + `\nkey: ${key}\n`);
    const before = (await git.git(['status', '--porcelain'], { cwd: a.brain })).stdout;
    const headBefore = await git.headSha(a.brain);
    let caught: unknown;
    try {
      await runSync({}, a.repo);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretFoundError);
    const e = caught as SecretFoundError;
    expect(e.exitCode).toBe(ExitCode.SecretFound);
    expect(e.findings).toHaveLength(1);
    expect(e.findings[0]).toMatchObject({ path: spec.path, kind: 'stripe secret key', masked: 'sk_l' + '*'.repeat(16) });
    expect(JSON.stringify(e.findings) + e.message).not.toContain(key);
    expect(cap.stdout.join('') + cap.stderr.join('')).not.toContain(key);
    expect((await git.git(['status', '--porcelain'], { cwd: a.brain })).stdout).toBe(before);
    expect(await git.headSha(a.brain)).toBe(headBefore);
    // Nothing staged either.
    expect((await git.git(['diff', '--cached', '--name-only'], { cwd: a.brain })).stdout).toBe('');
  });
});

describe('sync: validation, log entries, flags', () => {
  it('invalid frontmatter → exit 1 unless --allow-invalid; warnings do not block', async () => {
    const [a] = await setup();
    a.machine.use();
    write(path.join(a.brain, 'repos', 'payments-api', 'plans', '2026-09-09-bad.md'), '# no frontmatter\n');
    const e = await expectThoughtsError(() => runSync({}, a.repo));
    expect(e.exitCode).toBe(ExitCode.Validation);
    expect(cap.stderr.join('')).toContain('repos/payments-api/plans/2026-09-09-bad.md');
    expect(await git.headSha(a.brain)).toBe(await git.headSha(a.brain));
    const forced = await runSync({ allowInvalid: true }, a.repo);
    expect(forced.committed).toBeDefined();
    expect(forced.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('records updated (with status change) and removed entries', async () => {
    const [a] = await setup();
    a.machine.use();
    const spec = await runNew('spec', 'Lifecycle', {}, a.repo);
    await runSync({}, a.repo);
    const abs = path.join(a.brain, spec.path.slice(1));
    write(abs, read(abs).replace('status: draft', 'status: stable').replace('description: ', 'description: done'));
    const up = await runSync({}, a.repo);
    expect(up.entries).toEqual([{ change: 'updated', path: spec.path, title: 'Lifecycle', note: 'status draft → stable' }]);
    expect(read(path.join(a.brain, 'log.md'))).toContain('status draft → stable');
    fs.unlinkSync(abs);
    const rm = await runSync({}, a.repo);
    expect(rm.entries).toEqual([{ change: 'removed', path: spec.path, title: 'Lifecycle' }]);
    expect(rm.commitMessage).toBe(`thoughts(payments-api): 0 added, 0 updated\n\n- removed ${spec.path.slice(1)}`);
    expect(read(path.join(a.brain, 'repos/payments-api/index.md'))).not.toContain('Lifecycle');
  });

  it('--no-push commits and pulls only; --pull-only never commits; --watch is rejected', async () => {
    const [a] = await setup();
    a.machine.use();
    await runNew('plan', 'Local only', {}, a.repo);
    const s = await runSync({ push: false }, a.repo);
    expect(s.committed).toBeDefined();
    expect(s.pushed).toBe(false);
    expect(s.pulled).toBe(true);
    await runNew('plan', 'Not committed', {}, a.repo);
    const p = await runSync({ pullOnly: true }, a.repo);
    expect(p.committed).toBeUndefined();
    expect((await git.statusPorcelain(a.brain)).length).toBeGreaterThan(0);
    const w = await expectThoughtsError(() => runSync({ watch: '30s' }, a.repo));
    expect(w.exitCode).toBe(ExitCode.Validation);
    expect(w.message).toContain('not implemented in milestone 1');
  });

  it('runs in brain mode (inside the clone) with repo id "brain"', async () => {
    const [a] = await setup();
    a.machine.use();
    write(path.join(a.brain, 'shared', 'specs', '2026-09-09-x.md'), '---\ntype: Spec\ntitle: X\nstatus: draft\nrepo: shared\ngenerated:\n  by: human:qa\n  at: 2026-09-09T00:00:00Z\n---\n# X\n');
    const s = await runSync({}, path.join(a.brain, 'shared'));
    expect(s.repoId).toBe('brain');
    expect(s.commitMessage?.split('\n')[0]).toBe('thoughts(brain): 1 added, 0 updated');
  });
});
