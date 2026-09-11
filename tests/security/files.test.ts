/**
 * File-level scanner API: filename blocklist, unscannable files, scanFiles,
 * scanTree and the specs/15 performance bound. Fixtures are built from
 * repeated characters; assertions only ever look at `masked`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isBlockedFilename } from '../../src/security/blocklist.js';
import { MAX_SCAN_BYTES, hasBlocking, scanFile, scanFiles, scanTree } from '../../src/security/scanner.js';
import { makeTempEnv, writeFile, type TempEnv } from '../brain/helpers.js';

const rep = (s: string, n: number): string => s.repeat(n);
const STRIPE = 'sk_live_' + rep('4eC3', 6);

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

describe('filename blocklist (specs/15 "1.")', () => {
  it('matches every listed name on the basename only', () => {
    const blocked = [
      '.env',
      '.env.local',
      '.env.production',
      'server.pem',
      'private.key',
      'cert.p12',
      'cert.pfx',
      'keystore.jks',
      'id_rsa',
      'id_rsa.pub',
      'id_rsa_work',
      'id_ed25519',
      'id_ed25519.pub',
      'vault.kdbx',
      'credentials',
      'credentials.json',
      'service-account.json',
      'service-account-prod.json',
      '.netrc',
      '.npmrc',
      '.pypirc',
    ];
    for (const name of blocked) {
      expect(isBlockedFilename(name), name).toBe(true);
      expect(isBlockedFilename('/repos/svc/research/' + name), name).toBe(true);
      expect(isBlockedFilename('/abs/path/to/' + name), name).toBe(true);
    }
    const allowed = ['env', 'environment.md', 'keys.md', 'credentials.md', 'service-accounts.md', 'npmrc.md', 'README.md', 'brain.yml', ''];
    for (const name of allowed) expect(isBlockedFilename(name), name).toBe(false);
    // a directory called .env does not block files beneath it
    expect(isBlockedFilename('/.env/notes.md')).toBe(false);
  });
});

describe('scanFile', () => {
  it('reports a blocked filename with line 0 and an empty masked value, before reading content', async () => {
    const abs = await writeFile(env.root, 'brain/repos/svc/research/.env.local', 'nothing secret here\n');
    const findings = await scanFile(abs, '/repos/svc/research/.env.local');
    expect(findings).toEqual([
      expect.objectContaining({ path: '/repos/svc/research/.env.local', line: 0, kind: 'blocked filename', severity: 'block', masked: '' }),
    ]);
    expect(hasBlocking(findings)).toBe(true);
    // allow-listable by fingerprint like any other finding
    const allow = [{ fingerprint: findings[0]!.fingerprint, reason: 'test fixture', by: 'human:me', at: '2026-09-09T00:00:00Z' }];
    expect(await scanFile(abs, '/repos/svc/research/.env.local', { allow })).toEqual([]);
  });

  it('reports files over 1 MB as unscannable without reading them', async () => {
    const abs = path.join(env.root, 'big.md');
    await fs.promises.writeFile(abs, Buffer.alloc(MAX_SCAN_BYTES + 1, 0x61));
    const findings = await scanFile(abs, '/big.md');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: '/big.md', line: 0, severity: 'unscannable', masked: '' });
    expect(findings[0]!.kind).toContain('unscannable');
    expect(hasBlocking(findings)).toBe(true);
    // exactly 1 MB is still scanned
    await fs.promises.writeFile(abs, Buffer.alloc(MAX_SCAN_BYTES, 0x61));
    expect(await scanFile(abs, '/big.md')).toEqual([]);
  });

  it('reports a file with a NUL byte in the first 8 KB as unscannable', async () => {
    const abs = path.join(env.root, 'blob.md');
    await fs.promises.writeFile(abs, Buffer.concat([Buffer.from('text '), Buffer.from([0, 1, 2]), Buffer.from(' more')]));
    const findings = await scanFile(abs, '/blob.md');
    expect(findings.map((f) => [f.line, f.severity, f.masked])).toEqual([[0, 'unscannable', '']]);
    // a NUL only after the probe window does not make the file binary
    const late = path.join(env.root, 'late.md');
    await fs.promises.writeFile(late, Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
    expect(await scanFile(late, '/late.md')).toEqual([]);
  });

  it('scans text content and carries the display path into findings', async () => {
    const abs = await writeFile(env.root, 'brain/repos/svc/specs/x.md', '# spec\n\nkey: ' + STRIPE + '\n');
    const findings = await scanFile(abs, '/repos/svc/specs/x.md');
    expect(findings.map((f) => [f.path, f.line, f.kind, f.masked])).toEqual([['/repos/svc/specs/x.md', 3, 'stripe secret key', 'sk_l' + rep('*', 16)]]);
    expect(JSON.stringify(findings)).not.toContain(STRIPE);
  });
});

describe('scanFiles / scanTree', () => {
  it('accepts paths with or without a leading slash, skips missing files and directories', async () => {
    const root = path.join(env.root, 'brain');
    await writeFile(root, 'repos/svc/specs/a.md', 'token: ghp_' + rep('a', 36) + '\n');
    await writeFile(root, 'shared/decisions/b.md', 'clean\n');
    await writeFile(root, 'shared/plans/c.md', 'url: postgres://app:' + rep('pw', 8) + '@db/x\n');
    const findings = await scanFiles(root, ['repos/svc/specs/a.md', '/shared/decisions/b.md', './shared/plans/c.md', 'repos/svc/specs/deleted.md', 'shared']);
    expect(findings.map((f) => [f.path, f.kind, f.masked])).toEqual([
      ['/repos/svc/specs/a.md', 'github token', 'ghp_' + rep('*', 16)],
      ['/shared/plans/c.md', 'connection string', 'postgres://app:****@db/x'],
    ]);
    expect(await scanFiles(root, [])).toEqual([]);
  });

  it('scanTree walks every file except .git/ in sorted order', async () => {
    const root = path.join(env.root, 'brain');
    await writeFile(root, '.git/config', 'token: ghp_' + rep('a', 36) + '\n');
    await writeFile(root, '.git/objects/x', 'sk_live_' + rep('4eC3', 6) + '\n');
    await writeFile(root, 'brain.yml', 'name: b\n');
    await writeFile(root, 'repos/svc/research/.env', '');
    await writeFile(root, 'repos/svc/specs/z.md', 'ok\n');
    await writeFile(root, 'shared/specs/a.md', 'key: ' + STRIPE + '\n');
    const findings = await scanTree(root);
    expect(findings.map((f) => [f.path, f.kind])).toEqual([
      ['/repos/svc/research/.env', 'blocked filename'],
      ['/shared/specs/a.md', 'stripe secret key'],
    ]);
    expect(await scanTree(path.join(env.root, 'does-not-exist'))).toEqual([]);
  });

  it('honours the brain allow list and custom patterns across files', async () => {
    const root = path.join(env.root, 'brain');
    await writeFile(root, 'shared/specs/a.md', 'svc: svc_' + rep('Z9', 16) + '\nkey: ' + STRIPE + '\n');
    const first = await scanTree(root, { customPatterns: [{ name: 'internal-service-token', regex: 'svc_[A-Za-z0-9]{32}', severity: 'warn' }] });
    expect(first.map((f) => [f.kind, f.severity])).toEqual([
      ['internal-service-token', 'warn'],
      ['stripe secret key', 'block'],
    ]);
    const allow = first.map((f) => ({ fingerprint: f.fingerprint, reason: 'fixture', by: 'human:me', at: '2026-09-09T00:00:00Z' }));
    expect(await scanTree(root, { allow, customPatterns: [{ name: 'internal-service-token', regex: 'svc_[A-Za-z0-9]{32}', severity: 'warn' }] })).toEqual([]);
  });
});

describe('performance (specs/15 "Performance")', () => {
  it('scans 2,000 small files in well under 3 seconds', async () => {
    const root = path.join(env.root, 'brain');
    const body = [
      '---',
      'type: Spec',
      'title: Refund endpoint',
      'description: Add the v2 refund API with idempotency keys.',
      'status: draft',
      'generated:',
      '  by: human:tester',
      '  at: 2026-09-08T10:00:00Z',
      'repo: svc',
      '---',
      '# Refund endpoint',
      '',
      'The token is read from the vault at runtime; the password for the test',
      'database is `${DB_PASSWORD}` and the api_key placeholder is <your-key>.',
      'Connection: postgres://app@db.internal:5432/orders (no password inline).',
      '',
      '## Notes',
      '',
      'Some longer prose so the file has a realistic size. '.repeat(10),
      '',
    ].join('\n');
    const files: string[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const rel = 'repos/svc' + (i % 10) + '/specs/2026-09-' + String((i % 28) + 1).padStart(2, '0') + '-spec-' + i + '.md';
      files.push('/' + rel);
    }
    await Promise.all(files.map((rel) => writeFile(root, rel.slice(1), body)));
    // one real finding at the end so the run is not trivially empty
    await writeFile(root, 'shared/specs/leak.md', 'key: ' + STRIPE + '\n');

    const started = performance.now();
    const findings = await scanTree(root);
    const elapsed = performance.now() - started;
    expect(findings.map((f) => [f.path, f.kind])).toEqual([['/shared/specs/leak.md', 'stripe secret key']]);
    expect(elapsed).toBeLessThan(3000);
  });
});
