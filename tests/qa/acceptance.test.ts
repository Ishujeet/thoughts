/**
 * QA acceptance suite for milestone 1 — end-to-end checks of the acceptance
 * criteria in specs/01, 02, 03, 06, 07, 09 and 15 that the unit suites under
 * tests/brain, tests/security, tests/commands cover only in part, plus the
 * "nasty paths" (idempotent init, byte-identical user content around the
 * managed block, placeholders, determinism, validation, output contract).
 *
 * Every test runs against fs.mkdtemp "machines" (HOME, THOUGHTS_HOME,
 * THOUGHTS_CONFIG_DIR inside the temp root) with a local git brain. No
 * network, no real home directory, no real credential literal.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { packageRoot } from '../../src/assets.js';
import { loadBrainConfig, loadGlobalConfig } from '../../src/brain/config.js';
import { regenerate } from '../../src/brain/generate.js';
import { parseFrontmatter, parseThought, validateThought } from '../../src/brain/okf.js';
import { runInit } from '../../src/commands/init.js';
import { runNew } from '../../src/commands/new.js';
import { runScan } from '../../src/commands/scan.js';
import { runSync } from '../../src/commands/sync.js';
import * as git from '../../src/git.js';
import { setQuiet } from '../../src/output.js';
import { ALLOW_LIST_FILENAME } from '../../src/paths.js';
import { fingerprint, mask, scanText } from '../../src/security/scanner.js';
import { BUILTIN_TYPES, ExitCode, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END, SecretFoundError } from '../../src/types.js';
import {
  capture,
  cleanupMachines,
  commitAll,
  expectThoughtsError,
  fakeGithubToken,
  fakeStripeKey,
  makeBareBrain,
  makeCodeRepo,
  makeMachine,
  read,
  write,
  type Captured,
  type Machine,
} from '../commands/helpers.js';

const now = new Date('2026-09-09T12:00:00Z');

let m: Machine;
let cap: Captured;
beforeEach(async () => {
  m = await makeMachine('qa');
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

/** rel path → bytes for every regular file under `dir`, skipping .git and symlinks. */
function snapshot(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function expectSameSnapshot(a: Map<string, Buffer>, b: Map<string, Buffer>): void {
  expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
  for (const [rel, bytes] of a) expect(b.get(rel)!.equals(bytes), `file ${rel} changed`).toBe(true);
}

async function secretError(fn: () => Promise<unknown>): Promise<SecretFoundError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SecretFoundError) return err;
    throw err;
  }
  throw new Error('expected a SecretFoundError');
}

/** A code repo attached to a brand-new local brain (O1). */
async function attached(repoName = 'svc', brainName = 'b'): Promise<{ repo: string; brain: string }> {
  const repo = await makeCodeRepo(path.join(m.root, repoName));
  const r = await runInit({ yes: true, brain: path.join(m.root, brainName), now }, repo);
  cap.stdout.length = 0;
  cap.stderr.length = 0;
  return { repo, brain: r.brainRoot };
}

// ---------------------------------------------------------------------------
// specs/02 — init
// ---------------------------------------------------------------------------

describe('specs/02 init', () => {
  it('fresh repo + new brain: kind dirs, initial commit, symlink to the brain ROOT, /thoughts gitignored', async () => {
    const { repo, brain } = await attached('payments-api', 'acme-brain');
    expect(fs.readdirSync(path.join(repo, 'thoughts', 'repos', 'payments-api')).sort()).toEqual([
      'codegraph', 'decisions', 'index.md', 'plans', 'prs', 'research', 'specs',
    ]);
    // specs/01: the symlink target MUST be the brain root, so other repos and shared/ are reachable.
    expect(fs.realpathSync(path.join(repo, 'thoughts'))).toBe(fs.realpathSync(brain));
    expect(fs.existsSync(path.join(repo, 'thoughts', 'shared', 'decisions'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'thoughts', 'brain.yml'))).toBe(true);
    const log = (await git.git(['log', '--format=%s'], { cwd: brain })).stdout.trim().split('\n');
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[log.length - 1]).toBe('thoughts: create brain acme-brain');
    expect(read(path.join(repo, '.gitignore')).split('\n')).toContain('/thoughts');
    // The brain clone is clean after init (the initial sync folded everything into commits).
    expect(await git.statusPorcelain(brain)).toEqual([]);
  });

  it('re-running init is idempotent: every file in the repo and the brain is byte-identical, HEAD unchanged, attached[] not duplicated', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    write(path.join(repo, 'CLAUDE.md'), '# mine\n\nno trailing newline');
    write(path.join(repo, '.gitignore'), 'dist\n');
    const first = await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    const repoBefore = snapshot(repo);
    const brainBefore = snapshot(first.brainRoot);
    const head = await git.headSha(first.brainRoot);

    for (let i = 0; i < 2; i += 1) {
      const again = await runInit({ yes: true, now }, repo);
      expect(again.steps.filter((s) => s.state === 'created' || s.state === 'updated')).toEqual([]);
      expectSameSnapshot(repoBefore, snapshot(repo));
      expectSameSnapshot(brainBefore, snapshot(first.brainRoot));
      expect(await git.headSha(first.brainRoot)).toBe(head);
      expect(await git.statusPorcelain(first.brainRoot)).toEqual([]);
    }
    const global = await loadGlobalConfig();
    expect(global.attached).toHaveLength(1);
    expect(read(path.join(repo, '.gitignore'))).toBe('dist\n/thoughts\n');
  });

  it('managed block: user bytes before and after the block are untouched when the block is created AND when it is replaced (CRLF, no trailing newline)', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const before = '# Team notes\r\n\r\nKeep  this   exactly.\r\n\tTabs and trailing spaces   \r\nlast line without newline';
    write(path.join(repo, 'CLAUDE.md'), before);
    await runInit({ yes: true, brain: path.join(m.root, 'b'), now }, repo);
    let text = read(path.join(repo, 'CLAUDE.md'));
    expect(text.startsWith(before)).toBe(true);
    const begin = text.indexOf(MANAGED_BLOCK_BEGIN);
    expect(begin).toBeGreaterThan(before.length - 1);
    // Exactly one block, CRLF inside it, nothing after it yet.
    expect(text.indexOf(MANAGED_BLOCK_BEGIN, begin + 1)).toBe(-1);
    expect(text.endsWith(MANAGED_BLOCK_END + '\r\n')).toBe(true);
    expect(text.slice(begin)).not.toMatch(/[^\r]\n/);

    // The user adds content after the block and someone tampers with the block body.
    const after = '\r\n## More user notes\r\n\r\n- keep me too\r\n';
    const tampered = text.replace('Read it; write to it.', 'TAMPERED') + after;
    expect(tampered).not.toBe(text);
    write(path.join(repo, 'CLAUDE.md'), tampered);

    const again = await runInit({ yes: true, now }, repo);
    expect(again.steps.find((s) => s.step === 'claude-code CLAUDE.md managed block')?.state).toBe('updated');
    text = read(path.join(repo, 'CLAUDE.md'));
    const b2 = text.indexOf(MANAGED_BLOCK_BEGIN);
    const e2 = text.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length;
    // Bytes outside the markers: identical to the tampered file's outside bytes.
    expect(text.slice(0, b2)).toBe(tampered.slice(0, tampered.indexOf(MANAGED_BLOCK_BEGIN)));
    expect(text.slice(e2)).toBe(tampered.slice(tampered.indexOf(MANAGED_BLOCK_END) + MANAGED_BLOCK_END.length));
    expect(text.slice(0, b2)).toBe(before + '\r\n\r\n');
    expect(text.endsWith(after)).toBe(true);
    expect(text).not.toContain('TAMPERED');
    expect(text).toContain('Read it; write to it.');
    // A third run is a no-op.
    const third = await runInit({ yes: true, now }, repo);
    expect(third.steps.find((s) => s.step === 'claude-code CLAUDE.md managed block')?.state).toBe('up-to-date');
    expect(read(path.join(repo, 'CLAUDE.md'))).toBe(text);
  });

  it('same repo cloned to two paths: both symlinks valid, global config lists both paths under one repo_id', async () => {
    const repoA = await makeCodeRepo(path.join(m.root, 'work', 'payments-api'));
    await git.git(['remote', 'add', 'origin', 'git@github.com:acme/payments-api.git'], { cwd: repoA });
    const a = await runInit({ yes: true, brain: path.join(m.root, 'acme-brain'), now }, repoA);
    await commitAll(repoA, 'attach');
    const repoB = path.join(m.root, 'elsewhere', 'payments-api-copy');
    fs.mkdirSync(path.dirname(repoB), { recursive: true });
    await git.clone(repoA, repoB);
    const b = await runInit({ yes: true, now }, repoB);
    expect(b.repoId).toBe('payments-api');
    expect(b.brainRoot).toBe(a.brainRoot);
    expect(fs.realpathSync(path.join(repoA, 'thoughts'))).toBe(fs.realpathSync(a.brainRoot));
    expect(fs.realpathSync(path.join(repoB, 'thoughts'))).toBe(fs.realpathSync(a.brainRoot));
    const global = await loadGlobalConfig();
    const ids = global.attached.filter((x) => x.repo_id === 'payments-api').map((x) => x.path).sort();
    expect(ids).toEqual([fs.realpathSync(repoA), fs.realpathSync(repoB)].sort());
    expect(global.attached).toHaveLength(2);
    // brain.yml has the repo registered exactly once.
    expect(read(path.join(a.brainRoot, 'brain.yml')).match(/id: payments-api/g)).toHaveLength(1);
  });

  it('attached-not-initialised: new, sync and scan exit 5 with the exact message; init is exempt and repairs it', async () => {
    const host = await makeMachine('host');
    const bare = await makeBareBrain(host.root, 'acme-brain');
    const m1 = await makeMachine('one');
    const repoA = await makeCodeRepo(path.join(m1.root, 'payments-api'));
    await runInit({ yes: true, brain: bare, now }, repoA);
    await commitAll(repoA, 'attach');

    const m2 = await makeMachine('two');
    const repoB = path.join(m2.root, 'payments-api');
    await git.clone(repoA, repoB);
    for (const fn of [
      () => runNew('spec', 'X', { now }, repoB),
      () => runSync({}, repoB),
      () => runScan({}, repoB),
      () => runSync({}, path.join(repoB, 'src')),
    ]) {
      fs.mkdirSync(path.join(repoB, 'src'), { recursive: true });
      const e = await expectThoughtsError(fn);
      expect(e.exitCode).toBe(ExitCode.NotInitialised);
      expect(e.message).toBe('This repo is attached to brain acme-brain but not initialised on this machine.');
      expect(e.hint).toBe('Run: thoughts init');
    }
    // A wrong symlink target and a plain directory are "not initialised" too.
    fs.mkdirSync(path.join(repoB, 'thoughts'));
    expect((await expectThoughtsError(() => runSync({}, repoB))).exitCode).toBe(ExitCode.NotInitialised);
    fs.rmdirSync(path.join(repoB, 'thoughts'));
    fs.symlinkSync(m2.root, path.join(repoB, 'thoughts'));
    expect((await expectThoughtsError(() => runSync({}, repoB))).exitCode).toBe(ExitCode.NotInitialised);
    fs.unlinkSync(path.join(repoB, 'thoughts'));

    const r = await runInit({ yes: true, now }, repoB);
    expect(fs.lstatSync(path.join(repoB, 'thoughts')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(repoB, 'thoughts'))).toBe(fs.realpathSync(r.brainRoot));
    const created = await runNew('spec', 'Now it works', { now }, repoB);
    expect(fs.existsSync(created.absPath)).toBe(true);
    expect((await runScan({}, repoB)).findings).toEqual([]);
    expect((await runSync({}, repoB)).pushed).toBe(true);
  });

  it('older kit_version: new, sync and scan each print exactly one warning naming `thoughts kit update` and nothing refuses', async () => {
    const { repo } = await attached();
    const cfg = path.join(repo, '.thoughts.yml');
    write(cfg, read(cfg).replace(/kit_version: .*/, 'kit_version: 0.0.1'));
    for (const fn of [() => runNew('plan', 'P', { now }, repo), () => runScan({}, repo), () => runSync({ push: false }, repo)]) {
      cap.stderr.length = 0;
      await fn();
      const warnings = cap.stderr.filter((l) => l.includes('thoughts kit update'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^warning: Kit is outdated \(installed 0\.0\.1, CLI \d+\.\d+\.\d+\)/);
    }
  });

  it('a secret in brain.yml is refused at init with exit 7 and the value masked', async () => {
    const { brain } = await attached('seed');
    const token = fakeGithubToken();
    write(path.join(brain, 'brain.yml'), read(path.join(brain, 'brain.yml')) + `github_token: ${token}\n`);
    const repo = await makeCodeRepo(path.join(m.root, 'other'));
    const e = await secretError(() => runInit({ yes: true, brain: 'b', now }, repo));
    expect(e.exitCode).toBe(ExitCode.SecretFound);
    expect(e.findings.map((f) => [f.path, f.kind, f.masked])).toEqual([['/brain.yml', 'github token', mask(token)]]);
    expect(JSON.stringify(e.findings) + e.message + cap.stdout.join('') + cap.stderr.join('')).not.toContain(token);
    expect(await git.statusPorcelain(brain)).not.toEqual([]); // nothing was committed by init
  });

  it('init --json prints exactly one JSON document on stdout (contract §7)', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), json: true, now }, repo);
    const stdout = cap.stdout.join('');
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(stdout);
    }, 'stdout is not a single JSON document:\n' + stdout.slice(0, 200)).not.toThrow();
    expect(parsed).toMatchObject({ repoId: 'svc', brainId: 'b', brainRoot: r.brainRoot });
  });
});

// ---------------------------------------------------------------------------
// specs/03 + specs/15 — sync and secrets
// ---------------------------------------------------------------------------

describe('specs/03 sync: secrets (specs/15)', () => {
  it('placeholders are not flagged: sync commits a thought containing <your-password>, ${API_TOKEN}, {{TOKEN}}, changeme, xxx…', async () => {
    const { repo, brain } = await attached();
    const r = await runNew('research', 'Config shapes', { now }, repo);
    const lines = [
      'password: <your-password>',
      'token: ${API_TOKEN}',
      'api_key: {{ API_KEY }}',
      'secret: changeme-please-really',
      'client_secret: xxxxxxxxxxxxxxxxxxxxxxxx',
      'access_key: ********************',
      'auth: your-token-here',
      'PASSWORD = "REDACTED_BY_SECURITY"',
      'bearer: example-token-value',
      'private_key: <redacted:private key>',
      'pwd: short1',
    ];
    write(r.absPath, read(r.absPath) + '\n' + lines.join('\n') + '\n');
    expect(scanText(lines.join('\n'), '/x.md')).toEqual([]);
    const s = await runSync({ push: false, now }, repo);
    expect(s.committed).toBeDefined();
    expect(s.entries).toEqual([{ change: 'added', path: r.path, title: 'Config shapes', by: expect.stringMatching(/^human:/) }]);
    expect(await git.statusPorcelain(brain)).toEqual([]);
    expect((await git.git(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: brain })).stdout).toContain(r.path.slice(1));
  });

  it('a live-looking key → exit 7, nothing staged or committed, the raw value never appears; then fixed → commits', async () => {
    const { repo, brain } = await attached();
    const r = await runNew('spec', 'Webhooks', { now }, repo);
    const key = fakeStripeKey();
    write(r.absPath, read(r.absPath) + `\nUse ${key} for testing.\n`);
    const head = await git.headSha(brain);
    const before = await git.statusPorcelain(brain);
    const e = await secretError(() => runSync({ push: false, now }, repo));
    expect(e.exitCode).toBe(ExitCode.SecretFound);
    expect(e.findings).toEqual([
      expect.objectContaining({ path: r.path, kind: 'stripe secret key', severity: 'block', masked: 'sk_l' + '*'.repeat(16) }),
    ]);
    expect(e.findings[0]!.line).toBeGreaterThan(1);
    expect(JSON.stringify(e.findings) + e.message + cap.stdout.join('') + cap.stderr.join('')).not.toContain(key);
    expect(await git.headSha(brain)).toBe(head);
    expect(await git.statusPorcelain(brain)).toEqual(before);
    expect((await git.git(['diff', '--cached', '--name-only'], { cwd: brain })).stdout).toBe('');
    // index.md / log.md were not regenerated either (scan runs first).
    expect(read(path.join(brain, 'log.md'))).not.toContain('Webhooks');

    write(r.absPath, read(r.absPath).replace(key, '<redacted:stripe secret key>'));
    const ok = await runSync({ push: false, now }, repo);
    expect(ok.committed).toBeDefined();
    expect(read(path.join(brain, 'log.md'))).toContain('Webhooks');
  });

  it('a secret inside a brand-new (untracked) directory is still scanned', async () => {
    const { repo, brain } = await attached();
    const dir = path.join(brain, 'repos', 'svc', 'notes');
    const token = fakeGithubToken();
    write(
      path.join(dir, '2026-09-09-x.md'),
      `---\ntype: Note\ntitle: X\nstatus: draft\nrepo: svc\ngenerated:\n  by: human:qa\n  at: 2026-09-09T00:00:00Z\n---\ntoken ${token}\n`,
    );
    const head = await git.headSha(brain);
    const e = await secretError(() => runSync({ push: false, now }, repo));
    expect(e.findings.map((f) => [f.path, f.kind])).toEqual([['/repos/svc/notes/2026-09-09-x.md', 'github token']]);
    expect(await git.headSha(brain)).toBe(head);
    expect(cap.stdout.join('') + cap.stderr.join('')).not.toContain(token);
  });

  it('blocklisted filenames and binary files block sync with line 0 and no masked value', async () => {
    const { repo, brain } = await attached();
    write(path.join(brain, 'repos', 'svc', '.env'), 'FOO=bar\n');
    const e1 = await secretError(() => runSync({ push: false, now }, repo));
    expect(e1.findings).toEqual([expect.objectContaining({ path: '/repos/svc/.env', line: 0, kind: 'blocked filename', severity: 'block', masked: '' })]);
    fs.unlinkSync(path.join(brain, 'repos', 'svc', '.env'));

    const bin = path.join(brain, 'repos', 'svc', 'research', 'diagram.bin');
    fs.writeFileSync(bin, Buffer.concat([Buffer.from('PNG'), Buffer.alloc(16, 0), Buffer.from('tail')]));
    const e2 = await secretError(() => runSync({ push: false, now }, repo));
    expect(e2.findings).toEqual([expect.objectContaining({ path: '/repos/svc/research/diagram.bin', line: 0, severity: 'unscannable', masked: '' })]);
    expect(await git.statusPorcelain(brain)).not.toEqual([]);
    expect((await git.git(['diff', '--cached', '--name-only'], { cwd: brain })).stdout).toBe('');
  });

  it('inline <!-- thoughts:allow-secret reason="…" --> on the previous line suppresses that line; an empty reason does not', async () => {
    const { repo } = await attached();
    const r = await runNew('research', 'Onboarding', { now }, repo);
    const key = fakeStripeKey();
    const base = read(r.absPath);
    write(r.absPath, base + `\n<!-- thoughts:allow-secret reason="" -->\nexample: ${key}\n`);
    expect((await secretError(() => runSync({ push: false, now }, repo))).findings).toHaveLength(1);
    write(r.absPath, base + `\n<!-- thoughts:allow-secret reason="documented example key, revoked" -->\nexample: ${key}\n`);
    expect((await runSync({ push: false, now }, repo)).committed).toBeDefined();
    expect(cap.stdout.join('') + cap.stderr.join('')).not.toContain(key);
  });

  it('allow-listed fingerprint → sync passes; a changed value (different masked form) invalidates the entry', async () => {
    const { repo, brain } = await attached();
    const r = await runNew('research', 'Stripe notes', { now }, repo);
    const key = fakeStripeKey();
    write(r.absPath, read(r.absPath) + `\nkey: ${key}\n`);
    const e = await secretError(() => runSync({ push: false, now }, repo));
    const f = e.findings[0]!;
    expect(f.fingerprint).toBe(fingerprint(r.path, 'stripe secret key', mask(key), key));
    expect(f.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    write(
      path.join(brain, ALLOW_LIST_FILENAME),
      `allow:\n  - fingerprint: ${f.fingerprint}\n    reason: example key in the onboarding doc, not real\n    by: human:qa\n    at: 2026-09-09T10:12:00Z\n`,
    );
    const ok = await runSync({ push: false, now }, repo);
    expect(ok.committed).toBeDefined();
    // The allow-list file itself is committed as a reviewed change.
    expect((await git.git(['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: brain })).stdout).toContain(ALLOW_LIST_FILENAME);

    // fingerprint = sha256(path, kind, masked); masked = first 4 chars + up to 16 stars, so a
    // value with a different length class (shorter → fewer stars) changes the fingerprint.
    const shorter = 'sk_live_' + 'b'.repeat(10);
    expect(mask(shorter)).not.toBe(mask(key));
    write(r.absPath, read(r.absPath).replace(key, shorter));
    const again = await secretError(() => runSync({ push: false, now }, repo));
    expect(again.findings[0]!.fingerprint).not.toBe(f.fingerprint);
    expect(cap.stdout.join('') + cap.stderr.join('')).not.toContain(key);
    expect(cap.stdout.join('') + cap.stderr.join('')).not.toContain(shorter);
  });

  it('no detector can be disabled through brain.yml: same-name custom pattern with severity warn and entropy:false still block built-ins', async () => {
    const { repo, brain } = await attached();
    const cfg = path.join(brain, 'brain.yml');
    write(
      cfg,
      read(cfg) +
        'security:\n  entropy: false\n  patterns:\n    - name: stripe secret key\n      regex: "sk_live_[a-z]+"\n      severity: warn\n    - name: github token\n      regex: "ghp_[a-z]+"\n      severity: warn\n',
    );
    await commitAll(brain, 'config');
    const r = await runNew('research', 'Cfg', { now }, repo);
    write(r.absPath, read(r.absPath) + `\nk: ${fakeStripeKey()}\nt: ${fakeGithubToken()}\n`);
    const e = await secretError(() => runSync({ push: false, now }, repo));
    expect(e.findings.filter((f) => f.severity === 'block').map((f) => f.kind).sort()).toEqual(['github token', 'stripe secret key']);
  });

  it('git commit by hand inside the brain clone is refused by the pre-commit hook (thoughts on PATH)', async () => {
    const { repo, brain } = await attached();
    const r = await runNew('research', 'Hooked', { now }, repo);
    write(r.absPath, read(r.absPath) + `\nk: ${fakeStripeKey()}\n`);
    const binDir = path.join(m.root, 'bin');
    write(path.join(binDir, 'thoughts'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(packageRoot(), 'dist', 'index.js')}" "$@"\n`);
    fs.chmodSync(path.join(binDir, 'thoughts'), 0o755);
    const head = await git.headSha(brain);
    await git.git(['add', '-A'], { cwd: brain });
    let failed = false;
    try {
      await git.git(['commit', '-q', '-m', 'by hand'], { cwd: brain, env: { PATH: binDir + ':' + process.env.PATH } });
    } catch (err) {
      failed = true;
      expect((err as git.GitError).stderr).toContain('refusing to commit');
      expect((err as git.GitError).stderr).toContain('sk_l' + '*'.repeat(16));
    }
    expect(failed).toBe(true);
    expect(await git.headSha(brain)).toBe(head);
  });
});

describe('specs/03 sync: validation, generated files, output', () => {
  it('frontmatter without `type` fails validation → exit 1, nothing committed, file:line printed; --allow-invalid commits', async () => {
    const { repo, brain } = await attached();
    const rel = 'repos/svc/plans/2026-09-09-no-type.md';
    write(path.join(brain, rel), '---\ntitle: No type\nstatus: draft\nrepo: svc\ngenerated:\n  by: human:qa\n  at: 2026-09-09T00:00:00Z\n---\n# No type\n');
    const head = await git.headSha(brain);
    const e = await expectThoughtsError(() => runSync({ push: false, now }, repo));
    expect(e.exitCode).toBe(ExitCode.Validation);
    expect(cap.stderr.join('')).toMatch(new RegExp(`/${rel}:\\d+: error: type missing \\(okf/missing-field\\)`));
    expect(await git.headSha(brain)).toBe(head);
    expect((await git.git(['diff', '--cached', '--name-only'], { cwd: brain })).stdout).toBe('');
    // Also: no frontmatter at all, and unparsable YAML.
    write(path.join(brain, rel), '# just markdown\n');
    expect((await expectThoughtsError(() => runSync({ push: false, now }, repo))).exitCode).toBe(ExitCode.Validation);
    write(path.join(brain, rel), '---\ntype: [unclosed\n---\n# x\n');
    expect((await expectThoughtsError(() => runSync({ push: false, now }, repo))).exitCode).toBe(ExitCode.Validation);
    write(path.join(brain, rel), '---\ntitle: No type\nstatus: draft\nrepo: svc\ngenerated:\n  by: human:qa\n  at: 2026-09-09T00:00:00Z\n---\n# No type\n');
    const forced = await runSync({ push: false, allowInvalid: true, now }, repo);
    expect(forced.committed).toBeDefined();
    expect(forced.issues.some((i) => i.rule === 'okf/missing-field' && i.severity === 'error')).toBe(true);
    // The invalid thought still appears in the index (by its title) so it is not lost.
    expect(read(path.join(brain, 'repos', 'svc', 'index.md'))).toContain('[No type](/' + rel + ')');
  });

  it('generated index.md is deterministic: independent of creation order across machines, byte-identical on re-run, frontmatter only on the root index', async () => {
    const titles = ['Zeta spec', 'Alpha spec', 'Mid spec'];
    const outputs: Record<string, string>[] = [];
    for (const order of [titles, [...titles].reverse()]) {
      const mm = await makeMachine('det');
      const repo = await makeCodeRepo(path.join(mm.root, 'svc'));
      const r = await runInit({ yes: true, brain: path.join(mm.root, 'b'), now }, repo);
      for (const t of order) {
        await runNew('spec', t, { now }, repo);
        await runNew('decision', t + ' decision', { shared: true, now }, repo);
      }
      await runSync({ push: false, now }, repo);
      const first = snapshot(r.brainRoot);
      // Re-run: nothing changes, nothing is committed, bytes identical.
      const again = await runSync({ push: false, now }, repo);
      expect(again.committed).toBeUndefined();
      expectSameSnapshot(first, snapshot(r.brainRoot));
      const regen = await regenerate(r.brainRoot, await loadBrainConfig(r.brainRoot));
      expect(regen.changed).toEqual([]);
      outputs.push({
        root: read(path.join(r.brainRoot, 'index.md')),
        shared: read(path.join(r.brainRoot, 'shared', 'index.md')),
        repo: read(path.join(r.brainRoot, 'repos', 'svc', 'index.md')),
      });
    }
    expect(outputs[0]).toEqual(outputs[1]);
    const { root, shared, repo } = outputs[0]!;
    expect(root.startsWith('---\nokf_version: "0.2"\n---\n# b\n')).toBe(true);
    expect(shared.startsWith('---')).toBe(false);
    expect(repo.startsWith('---')).toBe(false);
    // Entries sorted by date desc then title; status suffix on drafts; LF only, single trailing newline.
    expect(repo).toBe(
      '# svc\n\n## Specs\n' +
        '* [Alpha spec](/repos/svc/specs/2026-09-09-alpha-spec.md) `draft`\n' +
        '* [Mid spec](/repos/svc/specs/2026-09-09-mid-spec.md) `draft`\n' +
        '* [Zeta spec](/repos/svc/specs/2026-09-09-zeta-spec.md) `draft`\n',
    );
    expect(root).toContain('## Zones\n* [shared](/shared/index.md) - 3 thoughts\n* repos - 3 thoughts across 1 repo\n* users - 0 thoughts across 0 users\n');
    expect(root).toContain('## Repos\n* [svc](/repos/svc/index.md) - 3 thoughts\n');
    expect(root).toContain('## Recently updated\n');
    for (const text of [root, shared, repo]) {
      expect(text).not.toContain('\r');
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
    }
  });

  it('log.md is append-only: past date sections are byte-identical after a sync, the new date goes on top', async () => {
    const { repo, brain } = await attached();
    const past = '## 2020-01-01\n* **Added**: [Old thing](/repos/svc/specs/2020-01-01-old-thing.md) by human:someone\n* **Updated**: [Older](/shared/decisions/2019-12-31-older.md) — status draft → stable\n';
    write(path.join(brain, 'log.md'), '# Log\n\n' + past);
    await commitAll(brain, 'seed log');
    const r = await runNew('spec', 'Fresh', { now }, repo);
    const s = await runSync({ push: false, now }, repo);
    expect(s.committed).toBeDefined();
    const log = read(path.join(brain, 'log.md'));
    expect(log.startsWith('# Log\n\n## 2026-09-09\n* **Added**: [Fresh](' + r.path + ') by human:')).toBe(true);
    expect(log.endsWith('\n\n' + past)).toBe(true);
    // A second thought on the same day is inserted at the top of the same section, once.
    const r2 = await runNew('plan', 'Second', { now }, repo);
    await runSync({ push: false, now }, repo);
    const log2 = read(path.join(brain, 'log.md'));
    expect(log2.startsWith('# Log\n\n## 2026-09-09\n* **Added**: [Second](' + r2.path + ')')).toBe(true);
    expect(log2.match(/## 2026-09-09/g)).toHaveLength(1);
    expect(log2.endsWith('\n\n' + past)).toBe(true);
    expect(log2.match(/\[Fresh\]/g)).toHaveLength(1);
  });

  it('additional kinds declared in brain.yml work end-to-end: new <kind>, own directory, own index section after the defaults', async () => {
    const { repo, brain } = await attached();
    const cfg = path.join(brain, 'brain.yml');
    write(cfg, read(cfg).replace('  prs:\n    template: pr\n', '  prs:\n    template: pr\n  rfcs:\n    template: spec\n'));
    await commitAll(brain, 'add rfcs kind');
    const r = await runNew('rfcs', 'Event naming', { now }, repo);
    expect(r.path).toBe('/repos/svc/rfcs/2026-09-09-event-naming.md');
    expect((await runNew('rfc', 'Singular', { now }, repo)).path).toBe('/repos/svc/rfcs/2026-09-09-singular.md');
    await runNew('spec', 'A spec', { now }, repo);
    await runSync({ push: false, now }, repo);
    const index = read(path.join(brain, 'repos', 'svc', 'index.md'));
    expect(index.indexOf('## Specs')).toBeGreaterThan(0);
    expect(index.indexOf('## Rfcs')).toBeGreaterThan(index.indexOf('## Specs'));
    expect(index).not.toContain('## Plans');
  });

  it('sync --json prints exactly one JSON document on stdout when a commit is made (contract §7)', async () => {
    const { repo } = await attached();
    await runNew('spec', 'J', { now }, repo);
    cap.stdout.length = 0;
    const s = await runSync({ push: false, json: true, now }, repo);
    const stdout = cap.stdout.join('');
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(stdout);
    }, 'stdout is not a single JSON document:\n' + stdout.slice(0, 200)).not.toThrow();
    expect(parsed).toMatchObject({ repoId: 'svc', committed: s.committed });
  });

  it('sync --quiet prints nothing on stdout; sync -m overrides only the first line', async () => {
    const { repo, brain } = await attached();
    const r = await runNew('spec', 'Q', { now }, repo);
    cap.stdout.length = 0;
    const s = await runSync({ push: false, quiet: true, message: 'custom subject', now }, repo);
    expect(cap.stdout.join('')).toBe('');
    expect(s.commitMessage).toBe('custom subject\n\n- added   ' + r.path.slice(1));
    expect((await git.git(['log', '-1', '--format=%B'], { cwd: brain })).stdout.trim()).toBe(s.commitMessage);
    setQuiet(false);
  });
});

// ---------------------------------------------------------------------------
// specs/06 + specs/07 — new and templates
// ---------------------------------------------------------------------------

describe('specs/06 new', () => {
  it('every built-in kind renders valid OKF frontmatter with status draft, the right type and zone, and no lint errors', async () => {
    const { repo } = await attached('payments-api', 'acme');
    for (const [kind, tpl] of [['plan', 'plan'], ['spec', 'spec'], ['research', 'research'], ['decision', 'decision'], ['pr', 'pr']] as const) {
      const r = await runNew(kind, `My ${kind} & co`, { now }, repo);
      expect(r.path).toBe(`/repos/payments-api/${kind === 'research' ? 'research' : kind + 's'}/2026-09-09-my-${kind}-co.md`);
      const t = await parseThought(r.absPath, r.path);
      expect(t.hasFrontmatter).toBe(true);
      expect(validateThought(t)).toEqual([]);
      expect(t.frontmatter).toMatchObject({
        type: BUILTIN_TYPES[tpl],
        title: `My ${kind} & co`,
        status: 'draft',
        repo: 'payments-api',
        generated: { by: expect.stringMatching(/^human:.+/), at: '2026-09-09T12:00:00Z' },
      });
      expect(read(r.absPath)).toContain('& co'); // not HTML-escaped
      expect(read(r.absPath)).not.toContain('&amp;');
      expect(cap.stdout.join('')).toContain(r.path + '\n');
    }
  });

  it('--set placeholder values are accepted; a real-looking token is refused before any write, masked, exit 7', async () => {
    const { repo, brain } = await attached();
    const ok = await runNew('research', 'Env', { set: ['ticket=${TICKET_ID}', 'pr=<your-pr-url>'], now }, repo);
    expect(read(ok.absPath)).toContain('ticket: ${TICKET_ID}');
    const dir = path.join(brain, 'repos', 'svc', 'research');
    const before = fs.readdirSync(dir).sort();
    const token = fakeGithubToken();
    const e = await secretError(() => runNew('research', 'Leak', { set: ['token=' + token], now }, repo));
    expect(e.exitCode).toBe(ExitCode.SecretFound);
    expect(e.findings).toEqual([expect.objectContaining({ path: '--set token', line: 1, kind: 'github token', masked: 'ghp_' + '*'.repeat(16) })]);
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    expect(JSON.stringify(e.findings) + e.message + cap.stdout.join('') + cap.stderr.join('')).not.toContain(token);
    // The scan is on the value, so a placeholder-looking key name does not help: `--set foo=<token>` is also refused.
    expect((await secretError(() => runNew('research', 'Leak2', { set: ['foo=' + token], now }, repo))).findings[0]!.path).toBe('--set foo');
  });

  it('same title twice → -2; slug is lowercase [a-z0-9-] capped at 60; --shared decision goes to shared/ with repo: shared', async () => {
    const { repo } = await attached();
    const long = 'Refund endpoint v2 ' + 'x'.repeat(100);
    const a = await runNew('spec', long, { now }, repo);
    const b = await runNew('spec', long, { now }, repo);
    const slugA = path.basename(a.path, '.md').slice('2026-09-09-'.length);
    expect(slugA.length).toBeLessThanOrEqual(60);
    expect(slugA).toMatch(/^[a-z0-9-]+$/);
    expect(b.path).toBe(a.path.replace(/\.md$/, '-2.md'));
    const d = await runNew('decision', 'Retry budget per service', { shared: true, now }, repo);
    expect(d.path).toBe('/shared/decisions/2026-09-09-retry-budget-per-service.md');
    expect(parseFrontmatter(read(d.absPath)).frontmatter.repo).toBe('shared');
    expect(validateThought(await parseThought(d.absPath, d.path))).toEqual([]);
  });

  it('templates.source brain: init copies the built-ins, an edited brain template is used, a missing one falls back to builtin with one warning', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), templates: 'brain', now }, repo);
    const tdir = path.join(r.brainRoot, 'templates');
    expect(fs.readdirSync(tdir).sort()).toEqual(['commit.md', 'decision.md', 'plan.md', 'pr.md', 'research.md', 'spec.md']);
    write(path.join(tdir, 'spec.md'), read(path.join(tdir, 'spec.md')).replace('## Summary', '## Org summary'));
    fs.unlinkSync(path.join(tdir, 'plan.md'));
    cap.stderr.length = 0;
    const s = await runNew('spec', 'Org', { now }, repo);
    expect(read(s.absPath)).toContain('## Org summary');
    const p = await runNew('plan', 'Fallback', { now }, repo);
    expect(read(p.absPath)).toContain('## Goal');
    await runNew('plan', 'Fallback again', { now }, repo);
    expect(cap.stderr.filter((l) => /plan\.md/.test(l) && /builtin|built-in|fall/i.test(l))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The built binary: exit codes as a user sees them
// ---------------------------------------------------------------------------

describe('built binary: exit codes end-to-end', () => {
  const root = packageRoot();
  const bin = path.join(root, 'dist', 'index.js');
  const run = promisify(execFile);

  beforeAll(async () => {
    if (!fs.existsSync(bin)) await run('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: root });
  }, 120_000);

  async function cli(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const env = {
      ...process.env,
      HOME: m.root,
      THOUGHTS_HOME: m.thoughtsHome,
      THOUGHTS_CONFIG_DIR: m.configDir,
      THOUGHTS_DEBUG: '',
    };
    try {
      const r = await run(process.execPath, [bin, ...args], { cwd, env });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('init 0 → new 0 → sync 0 → secret 7 (masked) → fresh copy 5 → init 0 → sync 0 → dry-run writes nothing', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'payments-api'));
    write(path.join(repo, 'CLAUDE.md'), '# my notes\n');
    const init = await cli(repo, 'init', '--yes', '--brain', path.join(m.root, 'acme-brain'));
    expect(init.code, init.stderr).toBe(0);
    expect(read(path.join(repo, 'CLAUDE.md')).startsWith('# my notes\n')).toBe(true);
    expect(read(path.join(repo, 'CLAUDE.md'))).toContain('thoughts:begin');

    const n1 = await cli(repo, 'new', 'spec', 'Refund endpoint v2');
    expect(n1.code).toBe(0);
    expect(n1.stdout.trim()).toMatch(/^\/repos\/payments-api\/specs\/\d{4}-\d{2}-\d{2}-refund-endpoint-v2\.md$/);
    const n2 = await cli(repo, 'new', 'spec', 'Refund endpoint v2');
    expect(n2.stdout.trim()).toMatch(/-refund-endpoint-v2-2\.md$/);
    const s1 = await cli(repo, 'sync', '--no-push');
    expect(s1.code, s1.stderr).toBe(0);
    expect(read(path.join(repo, 'thoughts', 'repos', 'payments-api', 'index.md'))).toContain('Refund endpoint v2');
    expect(read(path.join(repo, 'thoughts', 'index.md'))).toContain('okf_version');

    const leak = await cli(repo, 'new', 'research', 'Leak test', '--set', 'token=' + fakeGithubToken());
    expect(leak.code).toBe(ExitCode.SecretFound);
    expect(leak.stdout + leak.stderr).not.toContain(fakeGithubToken());
    expect(leak.stderr).toContain('ghp_' + '*'.repeat(16));
    expect(fs.readdirSync(path.join(repo, 'thoughts', 'repos', 'payments-api', 'research'))).toEqual(['.gitkeep']);

    const specFile = path.join(repo, 'thoughts', n1.stdout.trim().slice(1));
    write(specFile, read(specFile) + `key: ${fakeStripeKey()}\n`);
    const brain = fs.realpathSync(path.join(repo, 'thoughts'));
    const head = await git.headSha(brain);
    const s2 = await cli(repo, 'sync', '--no-push');
    expect(s2.code).toBe(ExitCode.SecretFound);
    expect(s2.stdout + s2.stderr).not.toContain(fakeStripeKey());
    expect(s2.stderr).toContain('✗ secret found — refusing to commit');
    expect(s2.stderr).toContain('sk_l' + '*'.repeat(16));
    expect(await git.headSha(brain)).toBe(head);
    expect((await git.git(['diff', '--cached', '--name-only'], { cwd: brain })).stdout).toBe('');
    write(specFile, read(specFile).replace(fakeStripeKey(), '<redacted:stripe>'));
    expect((await cli(repo, 'sync', '--no-push')).code).toBe(0);

    // A fresh copy of the attached repo on the same machine without the symlink.
    const copy = path.join(m.root, 'payments-api-copy');
    fs.cpSync(repo, copy, { recursive: true, verbatimSymlinks: true, filter: (p) => path.basename(p) !== 'thoughts' });
    expect(fs.existsSync(path.join(copy, 'thoughts'))).toBe(false);
    const s5 = await cli(copy, 'sync');
    expect(s5.code).toBe(ExitCode.NotInitialised);
    expect(s5.stderr).toContain('error: This repo is attached to brain acme-brain but not initialised on this machine.');
    expect(s5.stderr).toContain('Run: thoughts init');
    expect((await cli(copy, 'new', 'spec', 'X')).code).toBe(ExitCode.NotInitialised);
    const i2 = await cli(copy, 'init', '--yes');
    expect(i2.code, i2.stderr).toBe(0);
    expect(fs.lstatSync(path.join(copy, 'thoughts')).isSymbolicLink()).toBe(true);
    expect((await cli(copy, 'sync', '--no-push')).code).toBe(0);

    // --dry-run in a new repo writes nothing anywhere.
    const m2 = await makeMachine('dry');
    const r = await makeCodeRepo(path.join(m2.root, 'r'), { commit: false });
    const dry = await run(process.execPath, [bin, 'init', '--yes', '--brain', path.join(m2.root, 'b'), '--dry-run'], {
      cwd: r,
      env: { ...process.env, HOME: m2.root, THOUGHTS_HOME: m2.thoughtsHome, THOUGHTS_CONFIG_DIR: m2.configDir },
    });
    expect(dry.stdout).toContain('dry run: nothing was written');
    expect(fs.existsSync(path.join(r, 'thoughts'))).toBe(false);
    expect(fs.existsSync(path.join(r, '.thoughts.yml'))).toBe(false);
    expect(fs.existsSync(m2.thoughtsHome)).toBe(false);
    expect(fs.existsSync(path.join(m2.root, 'b'))).toBe(false);
    expect((await git.statusPorcelain(r)).map((e) => e.path)).toEqual(['README.md']);
  }, 60_000);
});
