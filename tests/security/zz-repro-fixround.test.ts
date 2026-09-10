import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRepoConfig } from '../../src/brain/config.js';
import { loadAllowList } from '../../src/security/allowlist.js';
import { scanText, fingerprint } from '../../src/security/scanner.js';

const rep = (s: string, n: number) => s.repeat(n);

describe('repro', () => {
  it('SEC-F2 repo_id traversal', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r-'));
    fs.writeFileSync(path.join(d, '.thoughts.yml'), 'brain: x\nrepo_id: ../evil\n');
    await expect(loadRepoConfig(d)).rejects.toThrow(/invalid repo_id/);
  });
  it('SEC-F3 allow entry without reason', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r-'));
    const text = 'key: sk_live_' + rep('b', 24);
    const [f] = scanText(text, '/a.md');
    fs.writeFileSync(path.join(d, '.thoughts-allow.yml'), 'allow:\n  - fingerprint: ' + f!.fingerprint + '\n');
    const allow = await loadAllowList(d);
    expect(scanText(text, '/a.md', { allow })).toHaveLength(1);
  });
  it('SEC-F4 fingerprint binds value', () => {
    const a = scanText('key: sk_live_' + rep('b', 24), '/a.md')[0]!;
    const b = scanText('key: sk_live_' + rep('c', 24), '/a.md')[0]!;
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(scanText('key: sk_live_' + rep('c', 24), '/a.md', { allow: [{ fingerprint: a.fingerprint, reason: 'x', by: '', at: '' }] })).toHaveLength(1);
  });
  it('SEC-F5 placeholder anchors', () => {
    const k = (t: string) => scanText(t, '/a.md').map((f) => f.kind);
    expect(k('api_key: this_is_an_example_9fKq2LmZpQ7rT')).not.toEqual([]);
    expect(k('password: real_redacted_lookalike_x8Kq2LmZ')).not.toEqual([]);
    expect(k('postgres://app:example_prod_pw_here@db/orders')).not.toEqual([]);
    for (const t of ['token: example', 'api_key: example-key-12345', 'password: REDACTED', 'secret: <redacted:aws>', 'password: <your-password>', 'token: ${API_TOKEN}']) expect(k(t)).toEqual([]);
  });
  it('SEC-F6 url credentials', () => {
    const k = (t: string) => scanText(t, '/a.md');
    const f = k('remote: https://alice:s3cr3tPasswd0123@git.internal/team/brain.git');
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('block');
    expect(JSON.stringify(f)).not.toContain('s3cr3tPasswd0123');
    for (const t of ['https://alice:<password>@host/x', 'https://alice:${TOKEN}@host/x', 'ssh://git@host/x', 'https://user@host/x', 'git@github.com:org/brain.git']) expect(k(t)).toEqual([]);
  });
});
