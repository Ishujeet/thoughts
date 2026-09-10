/** `thoughts init --yes` (specs/02 acceptance criteria, non-interactive path). */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readManagedBlock } from '../../src/adapters/managed-block.js';
import { loadGlobalConfig, loadRepoConfig } from '../../src/brain/config.js';
import { runInit } from '../../src/commands/init.js';
import { runSync } from '../../src/commands/sync.js';
import * as git from '../../src/git.js';
import { brainCloneDir } from '../../src/paths.js';
import { ExitCode, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END, SecretFoundError } from '../../src/types.js';
import {
  capture,
  cleanupMachines,
  commitAll,
  expectThoughtsError,
  fakeGithubToken,
  makeBareBrain,
  makeCodeRepo,
  makeMachine,
  read,
  write,
  type Captured,
  type Machine,
} from './helpers.js';

let m: Machine;
let cap: Captured;
beforeEach(async () => {
  m = await makeMachine('init');
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

const states = (r: { steps: { state: string }[] }) => new Set(r.steps.map((s) => s.state));

describe('init --yes: fresh repo + new brain (O1)', () => {
  it('creates the brain, clones it, registers the repo, symlinks, installs the kit, commits', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'payments-api'));
    write(path.join(repo, 'CLAUDE.md'), '# my notes\n\nKeep this.\n');
    const brainPath = path.join(m.root, 'acme-brain');
    const r = await runInit({ yes: true, brain: brainPath }, repo);

    expect(r.repoId).toBe('payments-api');
    expect(r.brainId).toBe('acme-brain');
    expect(r.brainRoot).toBe(brainCloneDir('acme-brain'));
    expect(states(r).has('dry-run')).toBe(false);

    // ls thoughts/repos/<id> shows the kind dirs; git -C thoughts log shows an initial commit.
    const link = path.join(repo, 'thoughts');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(r.brainRoot));
    expect(fs.readdirSync(path.join(link, 'repos', 'payments-api')).sort()).toEqual(['decisions', 'index.md', 'plans', 'prs', 'research', 'specs']);
    const log = (await git.git(['log', '--format=%s'], { cwd: link })).stdout.trim().split('\n');
    expect(log[log.length - 1]).toBe('thoughts: create brain acme-brain');
    expect(log[0]).toMatch(/^thoughts\(payments-api\): 0 added, 0 updated$/);
    expect(r.sync?.pushed).toBe(true);
    // ...and the push reached the brain at --brain path.
    expect((await git.git(['log', '--format=%s', '-1'], { cwd: brainPath })).stdout.trim()).toBe(log[0]);

    // .thoughts.yml, .gitignore, pre-commit hook, global config.
    const cfg = await loadRepoConfig(repo);
    expect(cfg).toMatchObject({ brain: brainPath, repo_id: 'payments-api', tools: ['claude-code'], kit_version: '0.1.0' });
    expect(read(path.join(repo, '.gitignore'))).toBe('/thoughts\n');
    const hook = path.join(r.brainRoot, '.git', 'hooks', 'pre-commit');
    expect(read(hook)).toContain('thoughts scan --staged');
    expect(fs.statSync(hook).mode & 0o111).not.toBe(0);
    const global = await loadGlobalConfig();
    expect(global.attached).toHaveLength(1);
    expect(global.attached[0]).toMatchObject({ path: fs.realpathSync(repo), repo_id: 'payments-api', brain: 'acme-brain' });
    expect(global.brains['acme-brain']?.remote).toBe(brainPath);
    expect(global.default_brain).toBe('acme-brain');

    // Kit: CLAUDE.md custom content byte-identical outside the managed block; commands installed.
    const claude = read(path.join(repo, 'CLAUDE.md'));
    expect(claude.startsWith('# my notes\n\nKeep this.\n\n' + MANAGED_BLOCK_BEGIN + '\n')).toBe(true);
    expect(claude.endsWith(MANAGED_BLOCK_END + '\n')).toBe(true);
    expect(readManagedBlock(claude)).toContain('This repo owns `thoughts/repos/payments-api/`.');
    expect(fs.readdirSync(path.join(repo, '.claude', 'commands'))).toHaveLength(8);
    // Summary printed on stdout.
    expect(cap.stdout.join('')).toContain('repo payments-api is attached to brain acme-brain');
  });

  it('re-running is a no-op: up-to-date everywhere, exit 0, nothing rewritten', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    write(path.join(repo, 'CLAUDE.md'), 'custom\r\nCRLF file\r\n');
    write(path.join(repo, '.gitignore'), 'node_modules\n');
    await runInit({ yes: true, brain: path.join(m.root, 'b') }, repo);
    const claude1 = read(path.join(repo, 'CLAUDE.md'));
    expect(claude1.startsWith('custom\r\nCRLF file\r\n')).toBe(true);
    expect(read(path.join(repo, '.gitignore'))).toBe('node_modules\n/thoughts\n');
    const head1 = await git.headSha(path.join(repo, 'thoughts'));

    const again = await runInit({ yes: true }, repo);
    const st = states(again);
    expect(st.has('created')).toBe(false);
    expect(st.has('updated')).toBe(false);
    expect(again.steps.filter((s) => s.state === 'up-to-date').length).toBeGreaterThanOrEqual(12);
    expect(read(path.join(repo, 'CLAUDE.md'))).toBe(claude1);
    expect(read(path.join(repo, '.gitignore'))).toBe('node_modules\n/thoughts\n');
    expect(await git.headSha(path.join(repo, 'thoughts'))).toBe(head1);
    expect((await git.statusPorcelain(path.join(repo, 'thoughts'))).length).toBe(0);
  });
});

describe('init --yes: second teammate and attached-not-initialised', () => {
  it('attaches a clone of an attached repo to the same brain with no prompts and no --brain', async () => {
    const bare = await makeBareBrain(m.root);
    const repoA = await makeCodeRepo(path.join(m.root, 'payments-api'));
    await runInit({ yes: true, brain: bare }, repoA);
    await commitAll(repoA, 'attach to brain');

    const m2 = await makeMachine('init2');
    const repoB = path.join(m2.root, 'payments-api');
    await git.clone(repoA, repoB);
    expect(fs.existsSync(path.join(repoB, '.thoughts.yml'))).toBe(true);

    // Fresh clone, not initialised here: every other command exits 5 with the init message.
    const e = await expectThoughtsError(() => runSync({}, repoB));
    expect(e.exitCode).toBe(ExitCode.NotInitialised);
    expect(e.message).toBe('This repo is attached to brain acme-brain but not initialised on this machine.');
    expect(e.hint).toBe('Run: thoughts init');

    const r = await runInit({ yes: true }, repoB);
    expect(r.brainId).toBe('acme-brain');
    expect(r.brainRoot).toBe(path.join(m2.thoughtsHome, 'brains', 'acme-brain'));
    expect(fs.realpathSync(path.join(repoB, 'thoughts'))).toBe(fs.realpathSync(r.brainRoot));
    expect((await loadRepoConfig(repoB))?.brain).toBe(bare);
    // .thoughts.yml was already right; kit files committed by the teammate are up-to-date.
    expect(r.steps.find((s) => s.step === '.thoughts.yml')?.state).toBe('up-to-date');
    expect(r.steps.filter((s) => s.step.includes('.claude/commands')).every((s) => s.state === 'up-to-date')).toBe(true);
    // ...and sync now works.
    const s = await runSync({}, repoB);
    expect(s.brainRoot).toBe(r.brainRoot);
  });

  it('warns once about an outdated kit and never refuses', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'svc'));
    await runInit({ yes: true, brain: path.join(m.root, 'b') }, repo);
    const cfgPath = path.join(repo, '.thoughts.yml');
    write(cfgPath, read(cfgPath).replace(/kit_version: .*/, 'kit_version: 0.0.1'));
    cap.stderr.length = 0;
    await runSync({}, repo);
    const warnings = cap.stderr.filter((l) => l.includes('thoughts kit update'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^warning: /);
  });
});

describe('init --dry-run', () => {
  it('writes nothing anywhere', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'r'));
    write(path.join(repo, 'CLAUDE.md'), '# notes\n');
    const before = (await git.git(['status', '--porcelain'], { cwd: repo })).stdout;
    const r = await runInit({ yes: true, brain: path.join(m.root, 'b'), dryRun: true }, repo);
    expect(r.dryRun).toBe(true);
    expect(r.steps.some((s) => s.state === 'dry-run')).toBe(true);
    expect(fs.existsSync(path.join(repo, 'thoughts'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.thoughts.yml'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(m.root, 'b'))).toBe(false);
    expect(fs.existsSync(m.thoughtsHome)).toBe(false);
    expect(fs.existsSync(m.configDir)).toBe(false);
    expect(read(path.join(repo, 'CLAUDE.md'))).toBe('# notes\n');
    expect((await git.git(['status', '--porcelain'], { cwd: repo })).stdout).toBe(before);
    expect(cap.stdout.join('')).toContain('dry run: nothing was written');
  });
});

describe('init exit codes', () => {
  it('1: no --yes (interactive guide not implemented), no --brain, outside a work tree, bad --brain path', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'r'));
    expect((await expectThoughtsError(() => runInit({}, repo))).exitCode).toBe(ExitCode.Validation);
    expect((await expectThoughtsError(() => runInit({}, repo))).message).toContain('re-run with --yes');
    const noBrain = await expectThoughtsError(() => runInit({ yes: true }, repo));
    expect(noBrain.exitCode).toBe(ExitCode.Validation);
    expect(noBrain.message).toContain('--brain is required');
    const plain = path.join(m.root, 'plain');
    fs.mkdirSync(plain);
    expect((await expectThoughtsError(() => runInit({ yes: true, brain: path.join(m.root, 'b') }, plain))).exitCode).toBe(ExitCode.Validation);
    write(path.join(m.root, 'notgit', 'file.txt'), 'x');
    const notRepo = await expectThoughtsError(() => runInit({ yes: true, brain: path.join(m.root, 'notgit') }, repo));
    expect(notRepo.exitCode).toBe(ExitCode.Validation);
    expect(fs.existsSync(path.join(repo, 'thoughts'))).toBe(false);
  });

  it('2: brain unreachable (clone failed)', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'r'));
    const e = await expectThoughtsError(() => runInit({ yes: true, brain: 'file://' + path.join(m.root, 'nope', 'brain.git') }, repo));
    expect(e.exitCode).toBe(ExitCode.RemoteUnreachable);
    expect(fs.existsSync(path.join(repo, 'thoughts'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.thoughts.yml'))).toBe(false);
  });

  it('3: existing thoughts/ path that is not a symlink to the brain; --force never deletes user content', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'r'));
    write(path.join(repo, 'thoughts', 'keep.md'), 'user content\n');
    const e = await expectThoughtsError(() => runInit({ yes: true, brain: path.join(m.root, 'b') }, repo));
    expect(e.exitCode).toBe(ExitCode.FsConflict);
    const forced = await expectThoughtsError(() => runInit({ yes: true, brain: path.join(m.root, 'b'), force: true }, repo));
    expect(forced.exitCode).toBe(ExitCode.FsConflict);
    expect(read(path.join(repo, 'thoughts', 'keep.md'))).toBe('user content\n');

    // An empty directory or a wrong symlink is replaced only with --force.
    const repo2 = await makeCodeRepo(path.join(m.root, 'r2'));
    fs.mkdirSync(path.join(repo2, 'thoughts'));
    expect((await expectThoughtsError(() => runInit({ yes: true, brain: path.join(m.root, 'b') }, repo2))).exitCode).toBe(ExitCode.FsConflict);
    const ok = await runInit({ yes: true, brain: path.join(m.root, 'b'), force: true }, repo2);
    expect(fs.lstatSync(path.join(repo2, 'thoughts')).isSymbolicLink()).toBe(true);
    expect(ok.steps.find((s) => s.step.startsWith('thoughts →'))?.state).toBe('updated');
  });

  it('7: a secret in the config being written is refused, masked', async () => {
    await runInit({ yes: true, brain: path.join(m.root, 'b') }, await makeCodeRepo(path.join(m.root, 'seed')));
    const repo = await makeCodeRepo(path.join(m.root, 'r'));
    const token = fakeGithubToken();
    write(path.join(repo, '.thoughts.yml'), `brain: ${path.join(m.root, 'b')}\nrepo_id: r\ntools: []\ngithub_token: ${token}\n`);
    let caught: unknown;
    try {
      await runInit({ yes: true }, repo);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretFoundError);
    const e = caught as SecretFoundError;
    expect(e.exitCode).toBe(ExitCode.SecretFound);
    expect(e.findings[0]?.masked).toBe('ghp_' + '*'.repeat(16));
    expect(JSON.stringify(e.findings)).not.toContain(token);
    expect(cap.stdout.join('') + cap.stderr.join('')).not.toContain(token);
  });
});

describe('init flags', () => {
  it('honours --repo-id, --tools, --no-commands, --templates brain, --integrations (skipped)', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'r'));
    const r = await runInit(
      { yes: true, brain: path.join(m.root, 'b'), repoId: 'orders', tools: 'claude-code,codex', commands: false, templates: 'brain', integrations: 'github' },
      repo,
    );
    expect(r.repoId).toBe('orders');
    expect(fs.existsSync(path.join(r.brainRoot, 'repos', 'orders', 'specs'))).toBe(true);
    expect(r.steps.find((s) => s.step === 'kit codex')).toMatchObject({ state: 'skipped' });
    expect(r.steps.find((s) => s.step === 'claude-code commands')).toMatchObject({ state: 'skipped', detail: '--no-commands' });
    expect(fs.existsSync(path.join(repo, '.claude', 'commands'))).toBe(false);
    expect(r.steps.find((s) => s.step === 'integration github')).toMatchObject({ state: 'skipped' });
    expect(fs.readdirSync(path.join(r.brainRoot, 'templates')).sort()).toEqual(['commit.md', 'decision.md', 'plan.md', 'pr.md', 'research.md', 'spec.md']);
    expect(read(path.join(r.brainRoot, 'brain.yml'))).toContain('source: brain');
    expect((await loadRepoConfig(repo))?.tools).toEqual(['claude-code', 'codex']);
  });

  it('uses the git remote name for repo_id and the union of tools', async () => {
    const repo = await makeCodeRepo(path.join(m.root, 'checkout'));
    await git.git(['remote', 'add', 'origin', 'git@github.com:acme/orders-service.git'], { cwd: repo });
    await runInit({ yes: true, brain: path.join(m.root, 'b') }, await makeCodeRepo(path.join(m.root, 'seed')));
    write(path.join(repo, '.thoughts.yml'), `brain: ${path.join(m.root, 'b')}\nrepo_id: orders-service\ntools: [pi]\nextra: keep\n`);
    const r = await runInit({ yes: true }, repo);
    expect(r.repoId).toBe('orders-service');
    const cfg = await loadRepoConfig(repo);
    // O2: `.thoughts.yml tools` wins over detection; init appends, never removes.
    expect(cfg?.tools).toEqual(['pi']);
    expect(cfg?.['extra']).toBe('keep');
    expect(r.steps.find((s) => s.step === 'kit pi')).toMatchObject({ state: 'skipped' });
  });
});
