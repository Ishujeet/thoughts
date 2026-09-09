import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  brainIdFromRemote,
  defaultUserId,
  loadBrainConfig,
  loadGlobalConfig,
  loadRepoConfig,
  resolveConfig,
  saveBrainConfig,
  saveGlobalConfig,
  saveRepoConfig,
} from '../../src/brain/config.js';
import { scaffoldBrain } from '../../src/brain/layout.js';
import { brainCloneDir, globalConfigPath } from '../../src/paths.js';
import { DEFAULT_KINDS, ExitCode, ThoughtsError, type BrainConfig } from '../../src/types.js';
import { makeTempEnv, readFile, writeFile, type TempEnv } from './helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

describe('brainIdFromRemote', () => {
  it('derives the repo name from every remote form', () => {
    expect(brainIdFromRemote('git@github.com:acme/acme-brain.git')).toBe('acme-brain');
    expect(brainIdFromRemote('https://x/y/z.git')).toBe('z');
    expect(brainIdFromRemote('https://x/y/z')).toBe('z');
    expect(brainIdFromRemote('/tmp/foo/my-brain/')).toBe('my-brain');
    expect(brainIdFromRemote('/tmp/foo/my-brain')).toBe('my-brain');
    expect(brainIdFromRemote('file:///a/b')).toBe('b');
    expect(brainIdFromRemote('ssh://git@host:2222/org/brain.git')).toBe('brain');
    expect(brainIdFromRemote('git@host:brain.git')).toBe('brain');
    expect(brainIdFromRemote('acme-brain')).toBe('acme-brain');
  });

  it('rejects an empty remote', () => {
    expect(() => brainIdFromRemote('')).toThrow(ThoughtsError);
  });
});

describe('global config', () => {
  it('returns defaults when the file is missing', async () => {
    expect(await loadGlobalConfig()).toEqual({ brains: {}, attached: [] });
  });

  it('round-trips and preserves unknown keys', async () => {
    await saveGlobalConfig({ user_id: 'ishujeet', brains: { b: { remote: 'x' } }, attached: [], custom_thing: { a: 1 } });
    expect(fs.existsSync(globalConfigPath())).toBe(true);
    expect(globalConfigPath().startsWith(env.configDir)).toBe(true);
    const cfg = await loadGlobalConfig();
    expect(cfg.user_id).toBe('ishujeet');
    expect(cfg.brains.b?.remote).toBe('x');
    expect(cfg.custom_thing).toEqual({ a: 1 });
  });

  it('writes keys in a stable order', async () => {
    await saveGlobalConfig({ attached: [], brains: {}, zeta: 1, alpha: 2, user_id: 'u' });
    const text = await fs.promises.readFile(globalConfigPath(), 'utf8');
    const keys = text.split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    expect(keys).toEqual(['user_id', 'brains', 'attached', 'alpha', 'zeta']);
  });
});

describe('repo config', () => {
  it('is undefined when absent', async () => {
    expect(await loadRepoConfig(env.root)).toBeUndefined();
  });

  it('defaults tools to [] and preserves unknown keys', async () => {
    await writeFile(env.root, '.thoughts.yml', 'brain: git@h:o/b.git\nrepo_id: r\nfuture_key: true\n');
    const cfg = await loadRepoConfig(env.root);
    expect(cfg).toMatchObject({ brain: 'git@h:o/b.git', repo_id: 'r', tools: [], future_key: true });
  });

  it('throws Validation when brain or repo_id is missing or the YAML is broken', async () => {
    await writeFile(env.root, '.thoughts.yml', 'repo_id: r\n');
    await expect(loadRepoConfig(env.root)).rejects.toMatchObject({ exitCode: ExitCode.Validation });
    await writeFile(env.root, '.thoughts.yml', 'brain: [unclosed\n');
    await expect(loadRepoConfig(env.root)).rejects.toMatchObject({ exitCode: ExitCode.Validation });
  });

  it('round-trips through save', async () => {
    await saveRepoConfig(env.root, { brain: 'x', repo_id: 'r', tools: ['claude-code'], kit_version: '0.1.0', extra: 'kept' });
    const text = await readFile(env.root, '.thoughts.yml');
    expect(text.split('\n')[0]).toBe('brain: x');
    expect(await loadRepoConfig(env.root)).toMatchObject({ brain: 'x', repo_id: 'r', tools: ['claude-code'], kit_version: '0.1.0', extra: 'kept' });
  });
});

describe('brain config', () => {
  it('applies defaults', async () => {
    await writeFile(env.root, 'brain.yml', 'name: acme\n');
    const cfg = await loadBrainConfig(env.root);
    expect(cfg.kind).toBe('project');
    expect(cfg.kinds).toEqual(DEFAULT_KINDS);
    expect(cfg.templates.source).toBe('builtin');
    expect(cfg.repos).toEqual([]);
    expect(cfg.okf_version).toBe('0.2');
  });

  it('throws Validation when brain.yml is missing or has no name', async () => {
    await expect(loadBrainConfig(env.root)).rejects.toMatchObject({ exitCode: ExitCode.Validation });
    await writeFile(env.root, 'brain.yml', 'kind: project\n');
    await expect(loadBrainConfig(env.root)).rejects.toMatchObject({ exitCode: ExitCode.Validation });
  });

  it('preserves unknown keys and custom kinds through save/load', async () => {
    await writeFile(
      env.root,
      'brain.yml',
      ['okf_version: "0.2"', 'name: acme', 'kinds:', '  adrs: { template: decision }', 'integrations:', '  github: { org: acme }', 'mystery: 42', ''].join('\n'),
    );
    const cfg = await loadBrainConfig(env.root);
    expect(cfg.kinds).toEqual({ adrs: { template: 'decision' } });
    expect(cfg.mystery).toBe(42);
    await saveBrainConfig(env.root, cfg);
    const text = await readFile(env.root, 'brain.yml');
    expect(text.startsWith('okf_version: "0.2"\nkind: project\nname: acme\n')).toBe(true);
    expect(text).toContain('mystery: 42');
    const again = await loadBrainConfig(env.root);
    expect(again).toEqual(cfg);
  });
});

describe('resolveConfig chain', () => {
  it('finds repo -> brain -> global', async () => {
    const remote = 'git@github.com:acme/acme-brain.git';
    const clone = brainCloneDir('acme-brain');
    await scaffoldBrain(clone, { name: 'acme' });
    const repo = path.join(env.root, 'code', 'svc');
    await writeFile(repo, '.thoughts.yml', 'brain: ' + remote + '\nrepo_id: svc\n');
    await fs.promises.mkdir(path.join(repo, 'src'), { recursive: true });
    await saveGlobalConfig({ user_id: 'me', brains: {}, attached: [] });

    const r = await resolveConfig(path.join(repo, 'src'));
    expect(r.repo?.repo_id).toBe('svc');
    expect(r.repoPath).toBe(path.join(repo, '.thoughts.yml'));
    expect(r.brain?.name).toBe('acme');
    expect(r.brainPath).toBe(path.join(clone, 'brain.yml'));
    expect(r.global.user_id).toBe('me');
    expect(r.globalPath).toBe(globalConfigPath());
  });

  it('works inside a brain clone and with --brain / default_brain outside any repo', async () => {
    const clone = brainCloneDir('solo');
    await scaffoldBrain(clone, { name: 'solo' });
    const inside = await resolveConfig(path.join(clone, 'shared'));
    expect(inside.repo).toBeUndefined();
    expect(inside.brain?.name).toBe('solo');

    const elsewhere = path.join(env.root, 'elsewhere');
    await fs.promises.mkdir(elsewhere);
    expect((await resolveConfig(elsewhere)).brain).toBeUndefined();
    expect((await resolveConfig(elsewhere, { brain: 'solo' })).brain?.name).toBe('solo');
    expect((await resolveConfig(elsewhere, { brain: 'git@h:o/solo.git' })).brain?.name).toBe('solo');
    expect((await resolveConfig(elsewhere, { brain: clone })).brain?.name).toBe('solo');
    await saveGlobalConfig({ default_brain: 'solo', brains: {}, attached: [] });
    expect((await resolveConfig(elsewhere)).brain?.name).toBe('solo');
  });

  it('--brain wins over .thoughts.yml', async () => {
    await scaffoldBrain(brainCloneDir('a'), { name: 'A' });
    await scaffoldBrain(brainCloneDir('b'), { name: 'B' });
    const repo = path.join(env.root, 'repo');
    await writeFile(repo, '.thoughts.yml', 'brain: /x/a.git\nrepo_id: r\n');
    expect((await resolveConfig(repo)).brain?.name).toBe('A');
    expect((await resolveConfig(repo, { brain: 'b' })).brain?.name).toBe('B');
  });
});

describe('defaultUserId', () => {
  it('prefers global user_id, then falls back to a non-empty id', async () => {
    expect(await defaultUserId({ user_id: 'ishujeet', brains: {}, attached: [] })).toBe('ishujeet');
    const id = await defaultUserId({ brains: {}, attached: [] });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toContain('@');
  });
});

describe('saveBrainConfig', () => {
  it('drops undefined values and keeps templates', async () => {
    const cfg: BrainConfig = {
      okf_version: '0.2',
      kind: 'project',
      name: 'n',
      repos: [{ id: 'r' }],
      kinds: DEFAULT_KINDS,
      templates: { source: 'brain' },
      description: undefined,
    };
    await saveBrainConfig(env.root, cfg);
    const text = await readFile(env.root, 'brain.yml');
    expect(text).not.toContain('description');
    expect(text).toContain('source: brain');
  });
});
