/**
 * Fix-round regressions for the commands package: QA-F1/F2/F6 (--json is one
 * document), QA-F3 (brain pre-commit hook fails closed), SEC-F1 (path
 * traversal via ids), SEC-F6 (remote-URL credentials), SEC-F8 (--set keys).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageRoot } from '../../src/assets.js';
import { assertRepoIdSegment, hasUrlCredentials, redactUrlCredentials, translateGitError } from '../../src/commands/common.js';
import { preCommitHookScript, runInit } from '../../src/commands/init.js';
import { parseSetValues, runNew } from '../../src/commands/new.js';
import { runSync } from '../../src/commands/sync.js';
import * as git from '../../src/git.js';
import { GitError } from '../../src/git.js';
import { ExitCode } from '../../src/types.js';
import { capture, cleanupMachines, expectThoughtsError, fakeStripeKey, makeCodeRepo, makeMachine, write, type Captured, type Machine } from './helpers.js';

const run = promisify(execFile);
const bin = path.join(packageRoot(), 'dist', 'index.js');
const now = new Date('2026-09-10T12:00:00Z');

/** Spawn a command with the current (temp-machine) env; never throws. */
async function spawn(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(cmd, args, { cwd, env: { ...process.env, THOUGHTS_DEBUG: '', ...env } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let m: Machine;
let cap: Captured;
beforeEach(async () => {
  m = await makeMachine('fix');
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

function parseOnly(stdout: string): unknown {
  let parsed: unknown;
  expect(() => {
    parsed = JSON.parse(stdout);
  }, 'stdout is not a single JSON document:\n' + stdout.slice(0, 300)).not.toThrow();
  return parsed;
}

describe('QA-F1/F2/F6: --json is exactly one JSON document; init folds the initial sync into its table', () => {
  it('init --json (in-process): one document carrying the initial-sync row and sync outcome', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), json: true, now }, repo);
    const parsed = parseOnly(cap.stdout.join('')) as { steps: { step: string; state: string; detail?: string }[]; sync?: { committed?: string } };
    expect(parsed.steps.find((s) => s.step === 'initial sync')).toMatchObject({ state: 'done' });
    expect(parsed.sync?.committed).toBe(r.sync?.committed);
    expect(cap.stdout.join('')).not.toMatch(/^(committed|pushed|nothing to do)/m);
  });

  it('sync --json (in-process): one document; progress lines never reach stdout', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    await runNew('spec', 'J', { now }, repo);
    cap.stdout.length = 0;
    const s = await runSync({ push: false, json: true, now }, repo);
    const stdout = cap.stdout.join('');
    expect(parseOnly(stdout)).toMatchObject({ repoId: 'svc', committed: s.committed, pushed: false });
    expect(stdout).not.toMatch(/^(committed|pushed|nothing to do|incoming)/m);
    // A second run with nothing to do is still a single document.
    cap.stdout.length = 0;
    await runSync({ push: false, json: true, now }, repo);
    expect(parseOnly(cap.stdout.join(''))).toMatchObject({ repoId: 'svc', incoming: [] });
  });

  it('human init prints the summary table in order with the initial-sync row before the closing line', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    const stdout = cap.stdout.join('');
    const table = stdout.indexOf('initial sync');
    const closing = stdout.indexOf('repo svc is attached to brain b');
    expect(table).toBeGreaterThan(-1);
    expect(closing).toBeGreaterThan(table);
    expect(stdout).toMatch(/initial sync\s+\(committed [0-9a-f]{7}/);
    expect(stdout).not.toMatch(/^committed /m);
  });

  it('built binary: init --yes --brain <path> --json and sync --no-push --json each parse as one document', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'r'));
    const i = await spawn(process.execPath, [bin, 'init', '--yes', '--brain', path.join(m.root, 'b'), '--json'], repo);
    expect(i.code, i.stderr).toBe(0);
    expect(parseOnly(i.stdout)).toMatchObject({ repoId: 'r', brainId: 'b' });
    const n = await spawn(process.execPath, [bin, 'new', 'spec', 'J'], repo);
    expect(n.code, n.stderr).toBe(0);
    const s = await spawn(process.execPath, [bin, 'sync', '--no-push', '--json'], repo);
    expect(s.code, s.stderr).toBe(0);
    expect(parseOnly(s.stdout)).toMatchObject({ repoId: 'r', pushed: false });
  });
});

describe('QA-F3: brain-clone pre-commit hook fails closed', () => {
  it('embeds the installing node + CLI and refuses when neither is available', () => {
    const script = preCommitHookScript('0.1.0');
    expect(script).toContain('command -v thoughts');
    expect(script).toContain(`elif [ -x '${process.execPath}' ] && [ -f '${bin}' ]`);
    expect(script).toContain('refusing commit');
    expect(script.trimEnd().endsWith('exit 1')).toBe(true);
    // Deterministic: re-running init compares byte-equal.
    expect(preCommitHookScript('0.1.0')).toBe(script);
    const weird = preCommitHookScript('0.1.0', { node: "/opt/it's/node", cli: '/x/cli.js' });
    expect(weird).toContain(`'/opt/it'\\''s/node'`);
  });

  it('git commit by hand with a stripped PATH: the hook scans, masks, and refuses (exit 1, no commit)', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    const brain = r.brainRoot;
    const head = await git.headSha(brain);
    fs.appendFileSync(path.join(brain, 'repos', 'svc', 'index.md'), `key: ${fakeStripeKey()}\n`);
    await git.addAll(brain);
    const c = await spawn('git', ['commit', '-qm', 'x'], brain, { PATH: '/usr/bin:/bin' });
    expect(c.code).toBe(1);
    const all = c.stdout + c.stderr;
    expect(all).toContain('refusing to commit');
    expect(all).toContain('sk_l');
    expect(all).not.toContain('sk_live_bbbb');
    expect(await git.headSha(brain)).toBe(head);
    // Drop the staged secret, then re-running init still finds the hook byte-equal.
    await git.git(['reset', '-q', '--hard', 'HEAD'], { cwd: brain });
    const again = await runInit({ yes: true, now }, repo);
    expect(again.steps.find((s) => s.step === 'brain pre-commit hook')?.state).toBe('up-to-date');
  });

  it('with no thoughts on PATH and no usable CLI path the hook exits 1 without committing', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    const brain = r.brainRoot;
    const hook = path.join(await git.hooksDir(brain), 'pre-commit');
    fs.writeFileSync(hook, preCommitHookScript('0.1.0', { node: '/nonexistent/node', cli: '/nonexistent/cli.js' }), { mode: 0o755 });
    const head = await git.headSha(brain);
    fs.appendFileSync(path.join(brain, 'repos', 'svc', 'index.md'), 'harmless\n');
    await git.addAll(brain);
    const c = await spawn('git', ['commit', '-qm', 'x'], brain, { PATH: '/usr/bin:/bin' });
    expect(c.code).toBe(1);
    expect(c.stderr).toContain('thoughts: CLI not found; refusing commit');
    expect(await git.headSha(brain)).toBe(head);
  });
});

describe('SEC-F1: ids are single path segments', () => {
  it('assertRepoIdSegment accepts plain ids and refuses ., .., separators', () => {
    for (const ok of ['payments-api', 'a.b_c', 'X1']) expect(() => assertRepoIdSegment(ok, 'repo id')).not.toThrow();
    for (const bad of ['.', '..', '../evil', 'a/b', '', ' x', '../../../../tmp/evil']) {
      let caught: unknown;
      try {
        assertRepoIdSegment(bad, 'repo id');
      } catch (err) {
        caught = err;
      }
      expect(caught, bad).toMatchObject({ exitCode: ExitCode.Validation, hint: 'use letters, digits, . _ -' });
    }
  });

  it('new --repo ../../../../tmp/evil exits 1 and writes nothing', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    const before = (await git.statusPorcelain(r.brainRoot)).length;
    const err = await expectThoughtsError(() => runNew('plan', 'x', { repo: '../../../../tmp/evil', now }, repo));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.hint).toBe('use letters, digits, . _ -');
    expect((await git.statusPorcelain(r.brainRoot)).length).toBe(before);
    expect(fs.existsSync(path.join(m.root, 'tmp', 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(m.root, '.thoughts', 'tmp'))).toBe(false);
  });

  it('a .thoughts.yml with repo_id: ../evil is refused by init and new; nothing lands outside repos/', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    write(path.join(repo, '.thoughts.yml'), `brain: ${path.join(m.root, 'b')}\nrepo_id: ../evil\ntools: []\n`);
    const e1 = await expectThoughtsError(() => runInit({ yes: true, now }, repo));
    expect(e1.exitCode).toBe(ExitCode.Validation);
    const e2 = await expectThoughtsError(() => runNew('plan', 'x', { now }, repo));
    expect(e2.exitCode).toBe(ExitCode.Validation);
    expect(fs.existsSync(path.join(m.thoughtsHome, 'brains', 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(m.thoughtsHome, 'brains', 'b', 'evil'))).toBe(false);
  });
});

describe('SEC-F6: remote-URL credentials', () => {
  it('redactUrlCredentials masks user:pass@ and leaves bare usernames and scp-style remotes alone', () => {
    expect(redactUrlCredentials('https://alice:s3cr3tPasswd@git.internal/team/brain.git')).toBe('https://***@git.internal/team/brain.git');
    expect(redactUrlCredentials('fatal: unable to access https://alice:pw@h/x: refused')).toBe('fatal: unable to access https://***@h/x: refused');
    expect(redactUrlCredentials('git@github.com:acme/brain.git')).toBe('git@github.com:acme/brain.git');
    expect(redactUrlCredentials('ssh://git@github.com/acme/brain.git')).toBe('ssh://git@github.com/acme/brain.git');
    expect(hasUrlCredentials('ssh://git@github.com/acme/brain.git')).toBe(false);
    expect(hasUrlCredentials('https://alice:pw@h/x')).toBe(true);
  });

  it('init --brain https://user:pass@host refuses before writing; the password is never printed', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const err = await expectThoughtsError(() => runInit({ yes: true, brain: 'https://alice:s3cr3tPasswd@git.internal/team/brain.git', now }, repo));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.message).toBe('brain URL contains embedded credentials');
    expect(err.hint).toBe('use a git credential helper or an SSH remote');
    expect(fs.existsSync(path.join(repo, '.thoughts.yml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'thoughts'))).toBe(false);
    expect(cap.stdout.join('') + cap.stderr.join('') + err.message + (err.hint ?? '')).not.toContain('s3cr3tPasswd');
    // Same from the built binary: exit 1, nothing leaks on either stream.
    const c = await spawn(process.execPath, [bin, 'init', '--yes', '--brain', 'https://alice:s3cr3tPasswd@git.internal/team/brain.git'], repo);
    expect(c.code).toBe(1);
    expect(c.stdout + c.stderr).not.toContain('s3cr3tPasswd');
    expect(c.stderr).toContain('brain URL contains embedded credentials');
  });

  it('a fetch failure naming a credentialed URL is reported with ***@', () => {
    const url = 'https://alice:s3cr3tPasswd@git.internal/team/brain.git';
    const e = translateGitError(new GitError(['fetch', 'origin'], `fatal: unable to access '${url}/': Could not resolve host`, 128), 'fetch', url);
    expect(e.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect(e.message).toContain('***@');
    expect(e.message).not.toContain('s3cr3tPasswd');
  });
});

describe('SEC-F8: --set keys cannot reach the prototype', () => {
  it('parseSetValues refuses __proto__/constructor/prototype and yields a null-prototype object', () => {
    for (const k of ['__proto__', 'constructor', 'prototype']) {
      let caught: unknown;
      try {
        parseSetValues([`${k}=y`]);
      } catch (err) {
        caught = err;
      }
      expect(caught, k).toMatchObject({ exitCode: ExitCode.Validation, message: `invalid --set key "${k}"` });
    }
    const v = parseSetValues(['owner=me']);
    expect(Object.getPrototypeOf(v)).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('new plan x --set __proto__=y exits 1 and writes nothing', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    const err = await expectThoughtsError(() => runNew('plan', 'x', { set: ['__proto__=y'], now }, repo));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(fs.readdirSync(path.join(r.brainRoot, 'repos', 'svc', 'plans')).filter((f) => f.endsWith('.md'))).toEqual([]);
    const c = await spawn(process.execPath, [bin, 'new', 'plan', 'x', '--set', '__proto__=y'], repo);
    expect(c.code).toBe(1);
  });
});
