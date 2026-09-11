/**
 * Final QA verification round — end-to-end confirmation of the fix round
 * (QA-F1..F6, SEC-F1..F8) at the command level, complementing the unit-level
 * regressions in tests/commands/fixround.test.ts and
 * tests/security/zz-repro-fixround.test.ts.
 *
 * Deferred findings (QA-F4, QA-F5, SEC-F7, SEC-F8 core part) are pinned here
 * so their agreed behaviour stays visible: QA-F4 as a behavioural test of the
 * supervisor decision, the rest as `it.todo` markers.
 *
 * Every test runs against fs.mkdtemp "machines"; no network, no real home
 * directory, secret-looking values are built at runtime.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packageRoot } from '../../src/assets.js';
import { defaultUserId, loadBrainConfig } from '../../src/brain/config.js';
import { runInit } from '../../src/commands/init.js';
import { runNew } from '../../src/commands/new.js';
import { runSync } from '../../src/commands/sync.js';
import * as git from '../../src/git.js';
import { ALLOW_LIST_FILENAME } from '../../src/paths.js';
import { mask } from '../../src/security/scanner.js';
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
} from '../commands/helpers.js';

const run = promisify(execFile);
const bin = path.join(packageRoot(), 'dist', 'index.js');
const now = new Date('2026-09-10T12:00:00Z');

/** A password-looking value built at runtime so no credential literal sits in the file. */
const password = 's3cr3t' + 'Passwd' + '0123';
const credentialedUrl = `https://alice:${password}@127.0.0.1:1/team/brain.git`;

async function spawn(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run(process.execPath, [bin, ...args], { cwd, env: { ...process.env, THOUGHTS_DEBUG: '' } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

async function secretError(fn: () => Promise<unknown>): Promise<SecretFoundError> {
  const err = await expectThoughtsError(fn);
  expect(err).toBeInstanceOf(SecretFoundError);
  expect(err.exitCode).toBe(ExitCode.SecretFound);
  return err as SecretFoundError;
}

let m: Machine;
let cap: Captured;
beforeEach(async () => {
  m = await makeMachine('final');
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

/** A code repo attached to a freshly created local brain; returns repo + brain clone root. */
async function attached(name = 'svc'): Promise<{ repo: string; brain: string }> {
  const repo = await makeCodeRepo(path.join(m.root, name));
  const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
  return { repo, brain: r.brainRoot };
}

function allOutput(): string {
  return cap.stdout.join('') + cap.stderr.join('');
}

describe('SEC-F2 (core): identifiers from config files are single path segments', () => {
  it('a brain.yml kind name with a path separator or `..` is refused with exit 1', async () => {
    for (const bad of ['../evil', 'a/b', '..', '.']) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-'));
      write(path.join(dir, 'brain.yml'), `name: b\nkinds:\n  "${bad}":\n    template: plan\n`);
      const err = await expectThoughtsError(() => loadBrainConfig(dir));
      expect(err.exitCode, bad).toBe(ExitCode.Validation);
      expect(err.message, bad).toContain('invalid kind name');
    }
  });

  it('a bad kind name in the attached brain stops `new` before anything is written', async () => {
    const { repo, brain } = await attached();
    write(path.join(brain, 'brain.yml'), read(path.join(brain, 'brain.yml')) + 'kinds:\n  "../evil":\n    template: plan\n');
    const err = await expectThoughtsError(() => runNew('plan', 'x', { now }, repo));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(fs.existsSync(path.join(m.root, 'evil'))).toBe(false);
    expect(fs.existsSync(path.join(brain, 'repos', 'evil'))).toBe(false);
  });

  it('an explicit global user_id that is not a single segment is refused', async () => {
    const err = await expectThoughtsError(() => defaultUserId({ user_id: '../root', brains: {}, attached: [] }));
    expect(err.exitCode).toBe(ExitCode.Validation);
  });

  it('SEC-F8 (core, deferred): a `__proto__` kind never reaches Object.prototype', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-'));
    write(path.join(dir, 'brain.yml'), 'name: b\nkinds:\n  __proto__:\n    template: evil\n  plans:\n    template: plan\n');
    const cfg = await loadBrainConfig(dir);
    expect(Object.keys(cfg.kinds)).toEqual(['plans']);
    expect(({} as Record<string, unknown>)['template']).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'template')).toBe(false);
  });
});

describe('SEC-F3 / SEC-F4: allow-list entries need a reason and are bound to the value', () => {
  it('an allow entry without a reason does not suppress the finding at sync time (warned, exit 7)', async () => {
    const { repo, brain } = await attached();
    const r = await runNew('research', 'Notes', { now }, repo);
    const key = fakeStripeKey();
    write(r.absPath, read(r.absPath) + `\nkey: ${key}\n`);
    const e = await secretError(() => runSync({ push: false, now }, repo));
    const fp = e.findings[0]!.fingerprint;

    write(path.join(brain, ALLOW_LIST_FILENAME), `allow:\n  - fingerprint: ${fp}\n    by: human:qa\n`);
    const again = await secretError(() => runSync({ push: false, now }, repo));
    expect(again.findings.map((f) => f.fingerprint)).toContain(fp);
    expect(cap.stderr.join('')).toContain('missing reason');

    write(path.join(brain, ALLOW_LIST_FILENAME), `allow:\n  - fingerprint: ${fp}\n    reason: "   "\n    by: human:qa\n`);
    await secretError(() => runSync({ push: false, now }, repo));
    expect(allOutput()).not.toContain(key);
  });

  it('a changed value with the SAME masked form invalidates the allow-list entry', async () => {
    const { repo, brain } = await attached();
    const r = await runNew('research', 'Notes', { now }, repo);
    const key = fakeStripeKey();
    write(r.absPath, read(r.absPath) + `\nkey: ${key}\n`);
    const e = await secretError(() => runSync({ push: false, now }, repo));
    const fp = e.findings[0]!.fingerprint;
    write(path.join(brain, ALLOW_LIST_FILENAME), `allow:\n  - fingerprint: ${fp}\n    reason: documented example, revoked\n    by: human:qa\n    at: 2026-09-10T00:00:00Z\n`);
    const ok = await runSync({ push: false, now }, repo);
    expect(ok.committed).toBeDefined();

    // Same length, same first four characters → identical mask, different value.
    const rotated = 'sk_live_' + 'b'.repeat(12) + 'c'.repeat(12);
    expect(mask(rotated)).toBe(mask(key));
    write(r.absPath, read(r.absPath).replace(key, rotated));
    const e2 = await secretError(() => runSync({ push: false, now }, repo));
    expect(e2.findings[0]!.fingerprint).not.toBe(fp);
    expect(e2.findings[0]!.masked).toBe(mask(key));
    expect(allOutput()).not.toContain(rotated);
    expect(allOutput()).not.toContain(key);
    // Nothing was committed on the refused run.
    expect((await git.statusPorcelain(brain)).length).toBeGreaterThan(0);
  });
});

describe('SEC-F5 / SEC-F6 (core): placeholder anchoring and URL credentials in thoughts', () => {
  it('a real-looking value that merely contains "redacted"/"example" is still refused by sync; true placeholders pass', async () => {
    const { repo } = await attached();
    const r = await runNew('research', 'Config notes', { now }, repo);
    const base = read(r.absPath);
    const lookalike = 'real_redacted_lookalike_' + 'x8Kq2LmZ';
    write(r.absPath, base + `\npassword: ${lookalike}\n`);
    await secretError(() => runSync({ push: false, now }, repo));
    expect(allOutput()).not.toContain(lookalike);

    write(r.absPath, base + '\npassword: <redacted>\ntoken: ${API_TOKEN}\napi_key: example-key-12345\n');
    const ok = await runSync({ push: false, now }, repo);
    expect(ok.committed).toBeDefined();
  });

  it('a thought with `https://user:password@host` is blocked; the output shows neither the password nor the raw URL', async () => {
    const { repo } = await attached();
    const r = await runNew('research', 'Remote notes', { now }, repo);
    write(r.absPath, read(r.absPath) + `\nremote: ${credentialedUrl}\n`);
    const e = await secretError(() => runSync({ push: false, now }, repo));
    expect(e.findings.some((f) => f.kind === 'url credentials' && f.severity === 'block')).toBe(true);
    expect(JSON.stringify(e.findings)).not.toContain(password);
    expect(allOutput()).not.toContain(password);
    // Built binary: exit 7, masked, password absent from both streams.
    const c = await spawn(['sync', '--no-push'], repo);
    expect(c.code).toBe(ExitCode.SecretFound);
    expect(c.stdout + c.stderr).not.toContain(password);
    expect(c.stderr).toContain('url credentials');
  });
});

describe('SEC-F6 (commands): a credentialed brain remote never leaks through git errors', () => {
  it('sync against an unreachable credentialed origin exits 2 with the password redacted (in-process and built binary)', async () => {
    const { repo, brain } = await attached();
    await git.git(['remote', 'set-url', 'origin', credentialedUrl], { cwd: brain });
    await runNew('plan', 'Rollout', { now }, repo);
    const err = await expectThoughtsError(() => runSync({ now }, repo));
    expect(err.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect(err.message).toContain('***@');
    expect(err.message + (err.hint ?? '')).not.toContain(password);
    expect(allOutput()).not.toContain(password);
    // The local commit was still made (specs/03: "Remote unreachable (local commit still made)").
    expect((await git.statusPorcelain(brain)).length).toBe(0);

    await runNew('plan', 'Rollout 2', { now }, repo);
    const c = await spawn(['sync'], repo);
    expect(c.code).toBe(ExitCode.RemoteUnreachable);
    expect(c.stdout + c.stderr).not.toContain(password);
    expect(c.stderr).toContain('***@');
  });

  it('init refuses a .thoughts.yml whose brain carries credentials, without echoing them', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    write(path.join(repo, '.thoughts.yml'), `brain: ${credentialedUrl}\nrepo_id: svc\ntools: []\n`);
    const err = await expectThoughtsError(() => runInit({ yes: true, now }, repo));
    expect(err.exitCode).toBe(ExitCode.Validation);
    expect(err.message + (err.hint ?? '') + allOutput()).not.toContain(password);
    expect(fs.existsSync(path.join(repo, 'thoughts'))).toBe(false);
    expect(fs.existsSync(path.join(m.thoughtsHome, 'brains'))).toBe(false);
  });
});

describe('QA-F4 (deferred by decision): unreachable brain remote', () => {
  it('first clone of an unreachable URL exits 2 and writes nothing; a missing local-path brain exits 2', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const e1 = await expectThoughtsError(() => runInit({ yes: true, brain: 'file:///nonexistent/thoughts-qa/brain.git', now }, repo));
    expect(e1.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect(fs.existsSync(path.join(repo, '.thoughts.yml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'thoughts'))).toBe(false);

    write(path.join(repo, '.thoughts.yml'), `brain: ${path.join(m.root, 'does-not-exist')}\nrepo_id: svc\ntools: []\n`);
    const e2 = await expectThoughtsError(() => runInit({ yes: true, now }, repo));
    expect(e2.exitCode).toBe(ExitCode.RemoteUnreachable);
  });

  it('re-init with the clone present but the remote gone warns, works offline and exits 0; the next sync exits 2 after committing locally', async () => {
    const bare = await makeBareBrain(m.root, 'acme-brain');
    const remote = 'file://' + bare;
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const first = await runInit({ yes: true, brain: remote, now }, repo);
    expect(first.sync?.pushed).toBe(true);

    fs.renameSync(bare, bare + '.gone');
    cap.stderr.length = 0;
    const again = await runInit({ yes: true, now }, repo);
    const cloneStep = again.steps.find((s) => s.step.startsWith('brain clone'));
    expect(cloneStep).toMatchObject({ state: 'up-to-date', detail: 'fetch failed; working offline' });
    expect(cap.stderr.join('')).toContain('could not fetch brain acme-brain');
    expect(again.sync?.pushed).toBe(false);

    await runNew('plan', 'Offline plan', { now }, repo);
    const err = await expectThoughtsError(() => runSync({ now }, repo));
    expect(err.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect((await git.statusPorcelain(first.brainRoot)).length).toBe(0);
    expect(await git.messageOf(first.brainRoot, 'HEAD')).toContain('thoughts(svc): 1 added, 0 updated');

    // Built binary agrees: re-init 0, sync 2.
    const i = await spawn(['init', '--yes'], repo);
    expect(i.code, i.stderr).toBe(0);
    const s = await spawn(['sync'], repo);
    expect(s.code).toBe(ExitCode.RemoteUnreachable);
  });
});

describe('deferred findings (no code change this round)', () => {
  it.todo('QA-F5: git.ts maps every execFile ENOENT to "git is not on PATH" even when the cwd does not exist (not reachable from a command today)');
  it.todo('SEC-F7: user text placed between the literal thoughts:begin/end markers is replaced by the managed block (markers are tool-owned by contract)');
  it.todo('SEC-F8 (core): normaliseKinds still assigns kinds[name] on a plain object; `__proto__` is dropped from keys but Object.create(null) refactor is pending');
});
