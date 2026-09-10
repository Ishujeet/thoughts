import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAllowList, serializeAllowList } from '../../src/security/allowlist.js';
import { ThoughtsError } from '../../src/types.js';
import { makeTempEnv, writeFile, type TempEnv } from '../brain/helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

describe('loadAllowList', () => {
  it('returns [] when <brain>/.thoughts-allow.yml is missing or empty', async () => {
    expect(await loadAllowList(path.join(env.root, 'nope'))).toEqual([]);
    const root = path.join(env.root, 'brain');
    await writeFile(root, '.thoughts-allow.yml', '');
    expect(await loadAllowList(root)).toEqual([]);
    await writeFile(root, '.thoughts-allow.yml', 'allow: []\n');
    expect(await loadAllowList(root)).toEqual([]);
  });

  it('reads the specs/15 shape, skips entries without a fingerprint and preserves unknown keys', async () => {
    const root = path.join(env.root, 'brain');
    await writeFile(
      root,
      '.thoughts-allow.yml',
      [
        '# committed allow list',
        'allow:',
        '  - fingerprint: sha256:' + 'a'.repeat(64),
        '    reason: example key in the onboarding doc, not real',
        '    by: human:ishujeet',
        '    at: 2026-09-09T10:12:00Z',
        '    ticket: CHK-12',
        '  - reason: no fingerprint here',
        '  - fingerprint: sha256:' + 'b'.repeat(64),
        '',
      ].join('\n'),
    );
    const entries = await loadAllowList(root);
    expect(entries).toEqual([
      { fingerprint: 'sha256:' + 'a'.repeat(64), reason: 'example key in the onboarding doc, not real', by: 'human:ishujeet', at: '2026-09-09T10:12:00Z', ticket: 'CHK-12' },
      { fingerprint: 'sha256:' + 'b'.repeat(64), reason: '', by: '', at: '' },
    ]);
  });

  it('throws a Validation error for unparsable YAML', async () => {
    const root = path.join(env.root, 'brain');
    await writeFile(root, '.thoughts-allow.yml', 'allow: [\n  - broken\n');
    await expect(loadAllowList(root)).rejects.toBeInstanceOf(ThoughtsError);
  });

  it('serializeAllowList round-trips through loadAllowList', async () => {
    const root = path.join(env.root, 'brain');
    const entries = [{ fingerprint: 'sha256:' + 'c'.repeat(64), reason: 'fixture', by: 'human:me', at: '2026-09-09T00:00:00Z' }];
    const text = serializeAllowList(entries);
    expect(text.startsWith('allow:\n')).toBe(true);
    await writeFile(root, '.thoughts-allow.yml', text);
    expect(await loadAllowList(root)).toEqual(entries);
  });
});
