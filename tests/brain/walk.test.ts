import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTextFiles, listThoughtPaths, listThoughts } from '../../src/brain/walk.js';
import { concept, makeTempEnv, writeFile, type TempEnv } from './helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

async function populate(root: string): Promise<void> {
  await writeFile(root, 'brain.yml', 'name: b\n');
  await writeFile(root, 'index.md', '---\nokf_version: "0.2"\n---\n# b\n');
  await writeFile(root, 'log.md', '# Log\n');
  await writeFile(root, 'templates/plan.md', 'template');
  await writeFile(root, 'shared/index.md', '# shared\n');
  await writeFile(root, 'shared/decisions/2026-09-01-d.md', concept({ title: 'D', repo: 'shared' }));
  await writeFile(root, 'shared/references/mirror.md', '# mirrored\n');
  await writeFile(root, 'shared/specs/notes.txt', 'not markdown');
  await writeFile(root, 'repos/svc/index.md', '# svc\n');
  await writeFile(root, 'repos/svc/specs/2026-09-08-b.md', concept({ title: 'B', repo: 'svc' }));
  await writeFile(root, 'repos/svc/specs/2026-09-08-a.md', concept({ title: 'A', repo: 'svc' }));
  await writeFile(root, 'repos/svc/log.md', '# log\n');
  await writeFile(root, 'users/me/plans/p.md', concept({ title: 'P', repo: 'user:me' }));
  await writeFile(root, '.git/objects/x', 'binary-ish');
  await writeFile(root, 'repos/.git/HEAD', 'ref');
}

describe('listThoughts', () => {
  it('lists every concept under the zones, sorted, skipping generated files, references/ and .git/', async () => {
    const root = path.join(env.root, 'brain');
    await populate(root);
    expect(await listThoughtPaths(root)).toEqual([
      '/repos/svc/specs/2026-09-08-a.md',
      '/repos/svc/specs/2026-09-08-b.md',
      '/shared/decisions/2026-09-01-d.md',
      '/users/me/plans/p.md',
    ]);
    const thoughts = await listThoughts(root);
    expect(thoughts.map((t) => t.frontmatter.title)).toEqual(['A', 'B', 'D', 'P']);
    expect(thoughts[0]?.absPath).toBe(path.join(root, 'repos', 'svc', 'specs', '2026-09-08-a.md'));
    expect(thoughts[0]?.location).toMatchObject({ zone: 'repos', owner: 'svc', kind: 'specs', date: '2026-09-08' });
  });

  it('returns [] for a brain with no zones', async () => {
    const root = path.join(env.root, 'empty');
    await fs.promises.mkdir(root);
    expect(await listThoughts(root)).toEqual([]);
  });
});

describe('listTextFiles', () => {
  it('lists every regular file except .git/, with leading slashes, sorted', async () => {
    const root = path.join(env.root, 'brain');
    await populate(root);
    const files = await listTextFiles(root);
    expect(files).toEqual([...files].sort());
    expect(files).toContain('/brain.yml');
    expect(files).toContain('/templates/plan.md');
    expect(files).toContain('/shared/specs/notes.txt');
    expect(files).toContain('/shared/references/mirror.md');
    expect(files.some((f) => f.includes('/.git/'))).toBe(false);
    expect(files.every((f) => f.startsWith('/'))).toBe(true);
  });
});
