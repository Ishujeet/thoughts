import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBrainConfig } from '../../src/brain/config.js';
import { renderIndexes } from '../../src/brain/generate.js';
import {
  compareVersions,
  ensureRepoDirs,
  findBrainRoot,
  findRepoRoot,
  kitOutdated,
  locate,
  registerRepo,
  scaffoldBrain,
} from '../../src/brain/layout.js';
import { parseFrontmatter } from '../../src/brain/okf.js';
import { DEFAULT_KINDS } from '../../src/types.js';
import { exists, makeTempEnv, readFile, writeFile, type TempEnv } from './helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

describe('locate', () => {
  it('classifies zone paths with and without a leading slash', () => {
    expect(locate('/repos/payments-api/specs/2026-09-08-x.md')).toEqual({
      path: '/repos/payments-api/specs/2026-09-08-x.md',
      zone: 'repos',
      owner: 'payments-api',
      kind: 'specs',
      date: '2026-09-08',
    });
    expect(locate('shared/decisions/no-date.md')).toEqual({ path: '/shared/decisions/no-date.md', zone: 'shared', kind: 'decisions' });
    expect(locate('/users/ishujeet/plans/2026-01-01-p.md')).toMatchObject({ zone: 'users', owner: 'ishujeet', kind: 'plans', date: '2026-01-01' });
    expect(locate('/shared/loose.md')).toEqual({ path: '/shared/loose.md', zone: 'shared' });
  });

  it('returns undefined outside zones and for generated files', () => {
    expect(locate('/index.md')).toBeUndefined();
    expect(locate('/brain.yml')).toBeUndefined();
    expect(locate('/templates/plan.md')).toBeUndefined();
    expect(locate('/shared/index.md')).toBeUndefined();
    expect(locate('/repos/x/log.md')).toBeUndefined();
    expect(locate('/repos/x')).toBeUndefined();
    expect(locate('/repos')).toBeUndefined();
    expect(locate('/standard/commands/x.md')).toBeUndefined();
  });
});

describe('findRepoRoot / findBrainRoot', () => {
  it('walks up from cwd inclusive', async () => {
    const repo = path.join(env.root, 'repo');
    await writeFile(repo, '.thoughts.yml', 'brain: x\nrepo_id: r\n');
    await fs.promises.mkdir(path.join(repo, 'a', 'b'), { recursive: true });
    expect(findRepoRoot(path.join(repo, 'a', 'b'))).toBe(repo);
    expect(findRepoRoot(repo)).toBe(repo);
    expect(findRepoRoot(env.root)).toBeUndefined();

    const brain = path.join(env.root, 'brain');
    await writeFile(brain, 'brain.yml', 'name: b\n');
    await fs.promises.mkdir(path.join(brain, 'shared', 'specs'), { recursive: true });
    expect(findBrainRoot(path.join(brain, 'shared', 'specs'))).toBe(brain);
    expect(findBrainRoot(repo)).toBeUndefined();
  });
});

describe('scaffoldBrain', () => {
  it('creates the layout, is idempotent, and never overwrites', async () => {
    const root = path.join(env.root, 'b');
    const created = await scaffoldBrain(root, { name: 'acme', description: 'Checkout platform' });
    expect(created).toContain('/brain.yml');
    expect(created).toContain('/index.md');
    expect(created).toContain('/log.md');
    for (const k of ['plans', 'specs', 'research', 'decisions']) expect(exists(root, path.join('shared', k, '.gitkeep'))).toBe(true);
    expect(exists(root, 'repos/.gitkeep')).toBe(true);
    expect(exists(root, 'users/.gitkeep')).toBe(true);
    expect(exists(root, '.git')).toBe(false);

    const brain = await loadBrainConfig(root);
    expect(brain).toMatchObject({ okf_version: '0.2', kind: 'project', name: 'acme', description: 'Checkout platform', repos: [], kinds: DEFAULT_KINDS });
    expect(brain.templates.source).toBe('builtin');
    const yml = await readFile(root, 'brain.yml');
    expect(yml.startsWith('okf_version: "0.2"\nkind: project\nname: acme\ndescription: Checkout platform\n')).toBe(true);

    const index = await readFile(root, 'index.md');
    const fm = parseFrontmatter(index);
    expect(fm.frontmatter.okf_version).toBe('0.2');
    expect(fm.body).toContain('# acme');
    // identical to what a later regenerate would produce for zero thoughts
    expect(index).toBe(renderIndexes([], brain)['/index.md']);
    expect(await readFile(root, 'log.md')).toBe('# Log\n\n');

    await writeFile(root, 'log.md', '# Log\n\n## 2026-01-01\n* **Added**: [x](/shared/specs/x.md)\n');
    const again = await scaffoldBrain(root, { name: 'other' });
    expect(again).toEqual([]);
    expect((await loadBrainConfig(root)).name).toBe('acme');
    expect(await readFile(root, 'log.md')).toContain('2026-01-01');
  });
});

describe('ensureRepoDirs / registerRepo', () => {
  it('creates kind dirs and appends to repos[] once', async () => {
    const root = path.join(env.root, 'b');
    await scaffoldBrain(root, { name: 'acme' });
    const created = await ensureRepoDirs(root, 'svc', DEFAULT_KINDS);
    expect(created).toEqual(Object.keys(DEFAULT_KINDS).map((k) => '/repos/svc/' + k + '/.gitkeep'));
    expect(await ensureRepoDirs(root, 'svc', DEFAULT_KINDS)).toEqual([]);

    expect(await registerRepo(root, { id: 'svc', remote: 'git@h:o/svc.git' })).toBe(true);
    expect(await registerRepo(root, { id: 'svc', remote: 'other' })).toBe(false);
    expect(await registerRepo(root, { id: 'two' })).toBe(true);
    const brain = await loadBrainConfig(root);
    expect(brain.repos).toEqual([{ id: 'svc', remote: 'git@h:o/svc.git' }, { id: 'two' }]);
    const yml = await readFile(root, 'brain.yml');
    expect(yml).toContain('repos:\n  - id: svc\n    remote: git@h:o/svc.git\n  - id: two\n');
  });

  it('preserves comments and unknown keys in brain.yml', async () => {
    const root = path.join(env.root, 'b');
    await writeFile(root, 'brain.yml', '# keep me\nname: acme\nmystery: 1\n');
    expect(await registerRepo(root, { id: 'svc' })).toBe(true);
    const yml = await readFile(root, 'brain.yml');
    expect(yml).toContain('# keep me');
    expect(yml).toContain('mystery: 1');
    expect((await loadBrainConfig(root)).repos).toEqual([{ id: 'svc' }]);
  });
});

describe('kitOutdated', () => {
  const repo = { brain: 'x', repo_id: 'r', tools: [] };
  it('treats a missing kit_version as outdated and compares numerically', () => {
    expect(kitOutdated(repo, '0.1.0')).toBe(true);
    expect(kitOutdated({ ...repo, kit_version: '0.1.0' }, '0.1.0')).toBe(false);
    expect(kitOutdated({ ...repo, kit_version: '0.0.9' }, '0.1.0')).toBe(true);
    expect(kitOutdated({ ...repo, kit_version: '0.10.0' }, '0.9.0')).toBe(false);
    expect(kitOutdated({ ...repo, kit_version: '1.0.0' }, '0.9.9')).toBe(false);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('v1.2.1', '1.2.0')).toBeGreaterThan(0);
  });
});
