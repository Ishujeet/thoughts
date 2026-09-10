import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveGlobalConfig } from '../../src/brain/config.js';
import { scaffoldBrain } from '../../src/brain/layout.js';
import { EXEMPT_COMMANDS, isInitialised, preflight } from '../../src/brain/preflight.js';
import { brainCloneDir } from '../../src/paths.js';
import { ExitCode, ThoughtsError } from '../../src/types.js';
import { makeTempEnv, writeFile, type TempEnv } from './helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

const REMOTE = 'git@github.com:acme/acme-brain.git';
const MESSAGE = 'This repo is attached to brain acme-brain but not initialised on this machine.';

async function makeRepo(kitVersion?: string): Promise<string> {
  const repo = path.join(env.root, 'code', 'payments-api');
  const lines = ['brain: ' + REMOTE, 'repo_id: payments-api', 'tools: [claude-code]'];
  if (kitVersion) lines.push('kit_version: ' + kitVersion);
  await writeFile(repo, '.thoughts.yml', lines.join('\n') + '\n');
  await fs.promises.mkdir(path.join(repo, 'src', 'deep'), { recursive: true });
  return repo;
}

async function makeClone(): Promise<string> {
  const clone = brainCloneDir('acme-brain');
  await scaffoldBrain(clone, { name: 'acme' });
  return clone;
}

async function expectNotInitialised(cwd: string, command = 'sync'): Promise<void> {
  let caught: unknown;
  try {
    await preflight(cwd, { command, cliVersion: '0.1.0' });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ThoughtsError);
  const e = caught as ThoughtsError;
  expect(e.exitCode).toBe(ExitCode.NotInitialised);
  expect(e.message).toBe(MESSAGE);
  expect(e.hint).toBe('Run: thoughts init');
}

describe('preflight: attached, not initialised', () => {
  it('symlink missing → exit 5', async () => {
    const repo = await makeRepo();
    await makeClone();
    await expectNotInitialised(path.join(repo, 'src', 'deep'));
  });

  it('thoughts is a regular directory, not a symlink → exit 5', async () => {
    const repo = await makeRepo();
    await makeClone();
    await fs.promises.mkdir(path.join(repo, 'thoughts'));
    await expectNotInitialised(repo);
  });

  it('symlink points at the wrong target → exit 5', async () => {
    const repo = await makeRepo();
    await makeClone();
    const other = brainCloneDir('other-brain');
    await scaffoldBrain(other, { name: 'other' });
    await fs.promises.symlink(other, path.join(repo, 'thoughts'));
    await expectNotInitialised(repo);
  });

  it('symlink is right but the clone is missing or lacks brain.yml → exit 5', async () => {
    const repo = await makeRepo();
    const clone = brainCloneDir('acme-brain');
    await fs.promises.symlink(clone, path.join(repo, 'thoughts'));
    await expectNotInitialised(repo); // dangling
    await fs.promises.mkdir(clone, { recursive: true });
    await expectNotInitialised(repo); // exists, no brain.yml
  });

  it('exempt commands do not throw and still report the repo', async () => {
    const repo = await makeRepo();
    expect(EXEMPT_COMMANDS).toEqual(['init', 'doctor', 'help', 'version']);
    for (const command of EXEMPT_COMMANDS) {
      const ctx = await preflight(repo, { command });
      expect(ctx.mode).toBe('repo');
      expect(ctx.repoRoot).toBe(repo);
      expect(ctx.repoConfig?.repo_id).toBe('payments-api');
      expect(ctx.brainId).toBe('acme-brain');
      expect(ctx.brainRoot).toBeUndefined();
    }
    // once the clone exists, init sees it even before the symlink is made
    await makeClone();
    const ctx = await preflight(repo, { command: 'init' });
    expect(ctx.brainRoot).toBe(brainCloneDir('acme-brain'));
    expect(ctx.brainConfig?.name).toBe('acme');
  });
});

describe('preflight: initialised repo', () => {
  it('returns repo mode with the brain loaded and no warnings when the kit is current', async () => {
    const repo = await makeRepo('0.1.0');
    const clone = await makeClone();
    await fs.promises.symlink(clone, path.join(repo, 'thoughts'));
    const ctx = await preflight(path.join(repo, 'src'), { command: 'sync', cliVersion: '0.1.0' });
    expect(ctx.mode).toBe('repo');
    expect(ctx.cwd).toBe(path.join(repo, 'src'));
    expect(ctx.repoRoot).toBe(repo);
    expect(ctx.brainRoot).toBe(clone);
    expect(ctx.brainId).toBe('acme-brain');
    expect(ctx.brainConfig?.name).toBe('acme');
    expect(ctx.warnings).toEqual([]);
    expect(await isInitialised(repo, clone)).toBe(true);
  });

  it('accepts a symlink through a different path spelling (realpath comparison)', async () => {
    const repo = await makeRepo('0.1.0');
    const clone = await makeClone();
    const alias = path.join(env.root, 'alias');
    await fs.promises.symlink(path.dirname(clone), alias);
    await fs.promises.symlink(path.join(alias, 'acme-brain'), path.join(repo, 'thoughts'));
    const ctx = await preflight(repo, { command: 'sync', cliVersion: '0.1.0' });
    expect(ctx.mode).toBe('repo');
    expect(ctx.brainRoot).toBe(clone);
  });

  it('warns (never refuses) when kit_version is older or missing', async () => {
    const repo = await makeRepo('0.0.1');
    const clone = await makeClone();
    await fs.promises.symlink(clone, path.join(repo, 'thoughts'));
    const ctx = await preflight(repo, { command: 'sync', cliVersion: '0.1.0' });
    expect(ctx.warnings).toEqual(['Kit is outdated (installed 0.0.1, CLI 0.1.0). Run: thoughts kit update']);

    await writeFile(repo, '.thoughts.yml', 'brain: ' + REMOTE + '\nrepo_id: payments-api\n');
    const none = await preflight(repo, { command: 'sync', cliVersion: '0.1.0' });
    expect(none.warnings).toHaveLength(1);
    expect(none.warnings[0]).toContain('Run: thoughts kit update');

    const noVersion = await preflight(repo, { command: 'sync' });
    expect(noVersion.warnings).toEqual([]);
  });
});

describe('preflight: brain and none modes', () => {
  it('runs inside a brain clone without a symlink', async () => {
    const clone = await makeClone();
    const ctx = await preflight(path.join(clone, 'shared', 'specs'), { command: 'lint' });
    expect(ctx.mode).toBe('brain');
    expect(ctx.brainRoot).toBe(clone);
    expect(ctx.brainId).toBe('acme-brain');
    expect(ctx.brainConfig?.name).toBe('acme');
    expect(ctx.repoRoot).toBeUndefined();
  });

  it('none mode uses --brain or default_brain when a clone exists, and never throws otherwise', async () => {
    const elsewhere = path.join(env.root, 'elsewhere');
    await fs.promises.mkdir(elsewhere);
    const bare = await preflight(elsewhere, { command: 'new' });
    expect(bare.mode).toBe('none');
    expect(bare.brainRoot).toBeUndefined();
    expect(bare.brainId).toBeUndefined();
    expect(bare.brainConfig).toBeUndefined();
    expect(bare.warnings).toEqual([]);

    const missing = await preflight(elsewhere, { command: 'new', brain: 'nope' });
    expect(missing.mode).toBe('none');
    expect(missing.brainRoot).toBeUndefined();

    const clone = await makeClone();
    const byId = await preflight(elsewhere, { command: 'new', brain: 'acme-brain' });
    expect(byId).toMatchObject({ mode: 'none', brainRoot: clone, brainId: 'acme-brain' });
    expect(byId.brainConfig?.name).toBe('acme');
    const byUrl = await preflight(elsewhere, { command: 'new', brain: REMOTE });
    expect(byUrl.brainRoot).toBe(clone);

    await saveGlobalConfig({ default_brain: 'acme-brain', brains: {}, attached: [] });
    const byDefault = await preflight(elsewhere, { command: 'new' });
    expect(byDefault.brainRoot).toBe(clone);
    expect(byDefault.global.default_brain).toBe('acme-brain');
  });
});
