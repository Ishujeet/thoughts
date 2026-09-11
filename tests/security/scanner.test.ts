/**
 * Detector tests. Every fixture is built programmatically from repeated
 * characters so nothing here resembles a live credential, and no raw value is
 * ever asserted on: assertions go through `masked` only.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint, hasBlocking, mask, scanText } from '../../src/security/scanner.js';
import type { Finding } from '../../src/types.js';

const rep = (s: string, n: number): string => s.repeat(n);

function kinds(text: string): string[] {
  return scanText(text, '/shared/specs/x.md').map((f) => f.kind);
}

function one(text: string): Finding {
  const findings = scanText(text, '/shared/specs/x.md');
  expect(findings).toHaveLength(1);
  return findings[0] as Finding;
}

/** The raw value must never leak into any finding field. */
function expectNoLeak(findings: Finding[], raw: string): void {
  const dump = JSON.stringify(findings);
  expect(dump).not.toContain(raw);
  for (const f of findings) expect(f.masked.length).toBeLessThanOrEqual(f.masked.startsWith('postgres') ? 200 : 20);
}

describe('mask / fingerprint / hasBlocking', () => {
  it('masks to the first 4 characters plus up to 16 stars', () => {
    expect(mask('abcdefgh')).toBe('abcd****');
    expect(mask('abcd')).toBe('****');
    expect(mask('ab')).toBe('****');
    expect(mask('abcde')).toBe('abcd*');
    expect(mask('sk_live_' + rep('4eC3', 6))).toBe('sk_l' + rep('*', 16));
    expect(mask(rep('a', 100))).toBe('aaaa' + rep('*', 16));
  });

  it('fingerprints path + kind + masked + sha256(raw) with sha256; the raw value itself never appears', () => {
    const raw = 'sk_live_' + rep('4eC3', 6);
    const rawHash = createHash('sha256').update(raw, 'utf8').digest('hex');
    const expected = 'sha256:' + createHash('sha256').update('/a.md\nstripe secret key\nsk_l****\n' + rawHash, 'utf8').digest('hex');
    expect(fingerprint('/a.md', 'stripe secret key', 'sk_l****', raw)).toBe(expected);
    expect(fingerprint('/a.md', 'stripe secret key', 'sk_l***', raw)).not.toBe(expected);
    expect(fingerprint('/a.md', 'stripe secret key', 'sk_l****', raw + 'x')).not.toBe(expected);
    expect(expected).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(expected).not.toContain(raw);
  });

  it('hasBlocking is true for block and unscannable only', () => {
    const f = (severity: Finding['severity']): Finding => ({ path: '/x', line: 1, kind: 'k', severity, masked: '', fingerprint: '' });
    expect(hasBlocking([])).toBe(false);
    expect(hasBlocking([f('warn')])).toBe(false);
    expect(hasBlocking([f('warn'), f('block')])).toBe(true);
    expect(hasBlocking([f('unscannable')])).toBe(true);
  });
});

describe('known-format detectors: positive and placeholder-negative fixtures', () => {
  it('aws access key', () => {
    const raw = 'AKIA' + rep('A1B2', 4);
    const f = one('key = ' + raw);
    expect(f).toMatchObject({ kind: 'aws access key', severity: 'block', line: 1, masked: 'AKIA' + rep('*', 16) });
    expectNoLeak([f], raw);
    expect(one('ASIA' + rep('C3D4', 4)).kind).toBe('aws access key');
    expect(kinds('AKIA' + rep('a', 16))).toEqual([]); // lowercase: not the format
    expect(kinds('AKIA<your-key-id>')).toEqual([]);
  });

  it('aws secret key', () => {
    const raw = rep('aB3/', 10);
    const f = one('aws_secret_access_key = ' + raw);
    expect(f.kind).toBe('aws secret key');
    expect(f.masked).toBe('aB3/' + rep('*', 16));
    expectNoLeak([f], raw);
    expect(kinds('aws_secret_access_key = <your-secret>')).toEqual([]);
    expect(kinds('aws_secret_access_key: ${AWS_SECRET_ACCESS_KEY}')).toEqual([]);
    expect(kinds('aws_secret_access_key: ' + rep('x', 40))).toEqual([]);
  });

  it('github tokens', () => {
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      const f = one('token: ' + prefix + rep('a', 36));
      expect(f.kind).toBe('github token');
      expect(f.masked).toBe(prefix + rep('*', 16));
    }
    expect(one('github_pat_' + rep('A', 22) + '_' + rep('b', 40)).kind).toBe('github token');
    expect(kinds('ghp_short')).toEqual([]);
    expect(kinds('token: ${GITHUB_TOKEN}')).toEqual([]);
  });

  it('gitlab token', () => {
    expect(one('glpat-' + rep('a', 20)).kind).toBe('gitlab token');
    expect(kinds('glpat-short')).toEqual([]);
  });

  it('slack token and webhook', () => {
    expect(one('xoxb-' + rep('1', 12) + '-' + rep('a', 24)).kind).toBe('slack token');
    expect(one('xoxp-' + rep('2', 12) + '-' + rep('b', 24)).kind).toBe('slack token');
    const hook = 'https://hooks.slack.com/services/T0A0A0A0A/B0B0B0B0B/' + rep('c', 24);
    const f = one(hook);
    expect(f.kind).toBe('slack webhook');
    expect(f.masked).toBe('http' + rep('*', 16));
    expect(kinds('https://hooks.slack.com/services/<team>/<bot>/<token>')).toEqual([]);
    expect(kinds('xoxb-<token>')).toEqual([]);
  });

  it('google api key', () => {
    const raw = 'AIza' + rep('Ab-_', 8) + 'ABC';
    expect(raw).toHaveLength(39);
    expect(one(raw).kind).toBe('google api key');
    expect(kinds('AIza' + rep('A', 10))).toEqual([]);
  });

  it('google service account json needs both type and private_key', () => {
    const key = rep('MIIE', 12);
    const json = ['{', '  "type": "service_account",', '  "project_id": "demo",', '  "private_key": "' + key + '",', '}'].join('\n');
    const findings = scanText(json, '/shared/research/sa.md');
    expect(findings.map((f) => [f.kind, f.line])).toEqual([['google service account', 4]]);
    expectNoLeak(findings, key);
    expect(kinds('{ "type": "service_account", "client_email": "x@y" }')).toEqual([]);
    expect(kinds('{ "private_key": "' + key + '" }')).toEqual([]);
    expect(kinds('{"type": "service_account",\n"private_key": "<redacted>"}')).toEqual([]);
  });

  it('stripe keys', () => {
    const raw = 'sk_live_' + rep('4eC3', 6);
    const f = one('const key = "' + raw + '";');
    expect(f).toMatchObject({ kind: 'stripe secret key', masked: 'sk_l' + rep('*', 16), severity: 'block' });
    expectNoLeak([f], raw);
    expect(one('sk_test_' + rep('4eC3', 6)).kind).toBe('stripe secret key');
    expect(one('rk_live_' + rep('4eC3', 6)).kind).toBe('stripe secret key');
    expect(one('whsec_' + rep('a', 32)).kind).toBe('stripe webhook secret');
    expect(kinds('sk_live_<your-key>')).toEqual([]);
    expect(kinds('sk_live_')).toEqual([]);
  });

  it('anthropic and openai keys', () => {
    expect(one('sk-ant-' + rep('a', 40)).kind).toBe('anthropic api key');
    expect(one('sk-proj-' + rep('b', 40)).kind).toBe('openai api key');
    expect(one('sk-' + rep('c', 40)).kind).toBe('openai api key');
    expect(kinds('sk-short')).toEqual([]);
    expect(kinds('sk-ant-${ANTHROPIC_API_KEY}')).toEqual([]);
  });

  it('azure devops / atlassian personal access tokens', () => {
    for (const key of ['pat', 'azure_devops_token', 'jira_token', 'ATLASSIAN_API_TOKEN']) {
      const f = one(key + ' = ' + rep('a1', 14));
      expect(f.kind).toBe('personal access token');
    }
    expect(kinds('pat: <your-pat-here>')).toEqual([]);
    expect(kinds('jira_token: ${JIRA_TOKEN}')).toEqual([]);
    expect(kinds('jira_token: ' + rep('x', 30))).toEqual([]);
    expect(kinds('pat: short')).toEqual([]);
    expect(kinds('path: /some/long/directory/path/here')).toEqual([]);
  });

  it('twilio, sendgrid, mailgun, npm, pypi, docker hub, vault', () => {
    expect(one('SK' + rep('0123456789abcdef', 2)).kind).toBe('twilio api key');
    expect(kinds('SK' + rep('g', 32))).toEqual([]);
    expect(one('SG.' + rep('a', 22) + '.' + rep('b', 43)).kind).toBe('sendgrid api key');
    expect(kinds('SG.short.short')).toEqual([]);
    expect(one('key-' + rep('a', 32)).kind).toBe('mailgun api key');
    expect(kinds('key-' + rep('a', 10))).toEqual([]);
    expect(one('npm_' + rep('a', 36)).kind).toBe('npm token');
    expect(kinds('npm_short')).toEqual([]);
    expect(one('pypi-' + rep('A', 40)).kind).toBe('pypi token');
    expect(kinds('pypi-short')).toEqual([]);
    expect(one('dckr_pat_' + rep('a', 27)).kind).toBe('docker hub token');
    expect(kinds('dckr_pat_short')).toEqual([]);
    expect(one('hvs.' + rep('a', 24)).kind).toBe('vault token');
    expect(kinds('hvs.short')).toEqual([]);
  });

  it('jwt', () => {
    const raw = 'eyJ' + rep('a', 20) + '.eyJ' + rep('b', 20) + '.' + rep('c', 20);
    const f = one(raw);
    expect(f.kind).toBe('jwt');
    expect(f.masked).toBe('eyJa' + rep('*', 16));
    expect(kinds('eyJ.eyJ.x')).toEqual([]);
    expect(kinds('eyJ' + rep('a', 20))).toEqual([]);
  });

  it('private key blocks', () => {
    for (const algo of ['RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'PGP ', 'ENCRYPTED ', '']) {
      const f = one('-----BEGIN ' + algo + 'PRIVATE KEY-----');
      expect(f.kind).toBe('private key');
      expect(f.masked).toBe('----' + rep('*', 16));
    }
    expect(kinds('-----BEGIN CERTIFICATE-----')).toEqual([]);
    expect(kinds('-----BEGIN PUBLIC KEY-----')).toEqual([]);
    expect(kinds('-----END RSA PRIVATE KEY-----')).toEqual([]);
  });

  it('connection strings mask only the password', () => {
    const pw = rep('hunter2', 3);
    const f = one('url: postgres://app:' + pw + '@db.internal:5432/orders');
    expect(f).toMatchObject({ kind: 'connection string', masked: 'postgres://app:****@db.internal:5432/orders' });
    expectNoLeak([f], pw);
    const schemes = ['postgresql://', 'mysql://', 'mongodb://', 'mongodb+srv://', 'redis://', 'amqp://', 'mssql://', 'jdbc:postgresql://'];
    for (const scheme of schemes) {
      const c = one(scheme + 'user:' + pw + '@host/db');
      expect(c.kind).toBe('connection string');
      expect(c.masked).toBe(scheme + 'user:****@host/db');
    }
    expect(kinds('postgres://app:${DB_PASSWORD}@db.internal/orders')).toEqual([]);
    expect(kinds('postgres://app:<password>@db.internal/orders')).toEqual([]);
    expect(kinds('postgres://db.internal:5432/orders')).toEqual([]);
    // a password that merely starts with `example` inside a real connection string is still a secret
    expect(kinds('postgres://app:example_prod_pw_here@db/orders')).toEqual(['connection string']);
  });

  it('url credentials: any scheme://user:password@host is blocked and masked whole (SEC-F6)', () => {
    const pw = 's3cr3tPasswd0123';
    const f = one('remote: https://alice:' + pw + '@git.internal/team/brain.git');
    expect(f).toMatchObject({ kind: 'url credentials', severity: 'block', masked: 'http' + rep('*', 16) });
    expectNoLeak([f], pw);
    expect(JSON.stringify([f])).not.toContain('git.internal');
    for (const scheme of ['http://', 'git://', 'ssh://', 'ftp://', 'svn+ssh://']) {
      expect(kinds(scheme + 'user:' + pw + '@host/x'), scheme).toEqual(['url credentials']);
    }
    // db schemes keep their own kind
    expect(kinds('mysql://user:' + pw + '@host/db')).toEqual(['connection string']);
    // placeholders and password-less forms
    for (const line of [
      'https://alice:<password>@host/x',
      'https://alice:${TOKEN}@host/x',
      'https://alice:xxxxxxxxxxxxxxxx@host/x',
      'ssh://git@host/x',
      'https://user@host/x',
      'git@github.com:org/brain.git',
      'https://git.internal/team/brain.git',
    ]) {
      expect(kinds(line), line).toEqual([]);
    }
  });

  it('cloud connection strings', () => {
    const key = rep('Ab+/', 11);
    expect(one('AccountKey=' + key).kind).toBe('azure account key');
    expect(one('SharedAccessSignature=sv=2020&sig=' + rep('a', 30)).kind).toBe('azure shared access signature');
    const full = 'DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=' + key + ';EndpointSuffix=core.windows.net';
    expect(one(full).kind).toBe('azure storage connection string');
    expect(kinds('AccountKey=<key>')).toEqual([]);
    expect(kinds('SharedAccessSignature=${SAS}')).toEqual([]);
    expect(kinds('DefaultEndpointsProtocol=https')).toEqual([]);
  });
});

describe('generic assignment pattern', () => {
  it('flags long values after a keyword and labels them', () => {
    const raw = 'correct-horse-battery-staple';
    const f = one('password: ' + raw);
    expect(f).toMatchObject({ kind: 'generic secret assignment', severity: 'block', masked: 'corr' + rep('*', 16) });
    expectNoLeak([f], raw);
    for (const key of ['passwd', 'pwd', 'SECRET', 'Token', 'api_key', 'api-key', 'apikey', 'access_key', 'auth', 'bearer', 'private_key', 'client-secret']) {
      expect(kinds(key + ' = "' + rep('q1', 8) + '"')).toEqual(['generic secret assignment']);
    }
  });

  it('does not flag placeholders or short values', () => {
    const negatives = [
      'password: <your-password>',
      'token: ${API_TOKEN}',
      'token: $API_TOKEN',
      'secret: {{ vault.secret }}',
      'password: ' + rep('x', 16),
      'password: ' + rep('X', 16),
      'api_key: "***"',
      'token: changeme',
      'token: change-me-please',
      'client_secret: example-client-secret',
      'access_key: your-access-key-here',
      'password: REDACTED',
      'password: <redacted:generic secret assignment>',
      'pwd: short',
      'token: eleven-char',
      'The password reset flow is described below.',
      'auth: true',
      'token: example',
      'api_key: example-key-12345',
      'password: REDACTED',
      'secret: <redacted:aws>',
    ];
    for (const line of negatives) expect(kinds(line), line).toEqual([]);
  });

  it('placeholder words are anchored: a real value containing them is still flagged (SEC-F5)', () => {
    expect(kinds('api_key: this_is_an_example_9fKq2LmZpQ7rT')).toEqual(['generic secret assignment']);
    expect(kinds('password: real_redacted_lookalike_x8Kq2LmZ')).toEqual(['generic secret assignment']);
    expect(kinds('token: not-a-placeholder-9fKq2LmZ')).toEqual(['generic secret assignment']);
    expect(kinds('secret: myfake_9fKq2LmZpQ7rT')).toEqual(['generic secret assignment']);
  });
});

describe('custom patterns, allow list, inline allow', () => {
  const raw = 'svc_' + rep('Z9', 16);

  it('custom patterns are additive with their own severity and cannot disable built-ins', () => {
    const text = 'svc: ' + raw + '\nkey: sk_live_' + rep('4eC3', 6) + '\n';
    const warn = scanText(text, '/a.md', { customPatterns: [{ name: 'internal-service-token', regex: 'svc_[A-Za-z0-9]{32}', severity: 'warn' }] });
    expect(warn.map((f) => [f.kind, f.severity, f.line])).toEqual([
      ['internal-service-token', 'warn', 1],
      ['stripe secret key', 'block', 2],
    ]);
    const block = scanText(text, '/a.md', { customPatterns: [{ name: 'internal-service-token', regex: 'svc_[A-Za-z0-9]{32}', severity: 'block' }] });
    expect(block[0]?.severity).toBe('block');
    // a custom pattern that "matches" a built-in prefix does not replace the built-in kind
    const shadow = scanText('sk_live_' + rep('4eC3', 6), '/a.md', { customPatterns: [{ name: 'stripe-override', regex: 'sk_live_[A-Za-z0-9]+', severity: 'warn' }] });
    expect(shadow.map((f) => f.kind)).toEqual(['stripe secret key']);
    expectNoLeak(warn, raw);
  });

  it('rejects an invalid custom regex with a Validation error', () => {
    expect(() => scanText('x', '/a.md', { customPatterns: [{ name: 'bad', regex: '(', severity: 'block' }] })).toThrow(/invalid security pattern bad/);
  });

  it('allow-listed fingerprints are dropped; changing the value brings the finding back', () => {
    const text = 'key: sk_live_' + rep('4eC3', 6);
    const [f] = scanText(text, '/repos/svc/research/x.md');
    expect(f).toBeDefined();
    const allow = [{ fingerprint: (f as Finding).fingerprint, reason: 'example in onboarding doc', by: 'human:me', at: '2026-09-09T10:12:00Z' }];
    expect(scanText(text, '/repos/svc/research/x.md', { allow })).toEqual([]);
    // same masked prefix, different path → different fingerprint → still found
    expect(scanText(text, '/repos/svc/research/y.md', { allow })).toHaveLength(1);
    // The fingerprint binds path + kind + masked + sha256(raw value), so any change to the
    // value — a different length (fewer stars) or the same masked form — invalidates the entry.
    const changed = 'key: sk_live_' + rep('9z', 5);
    expect(mask('sk_live_' + rep('9z', 5))).not.toBe((f as Finding).masked);
    expect(scanText(changed, '/repos/svc/research/x.md', { allow })).toHaveLength(1);
  });

  it('fingerprint binds the value: same path, kind, prefix and length still differ; moving lines does not (SEC-F4)', () => {
    const p = '/repos/svc/research/x.md';
    const a = 'sk_live_' + rep('b', 24);
    const b = 'sk_live_' + rep('c', 24);
    expect(mask(a)).toBe(mask(b));
    const [fa] = scanText('key: ' + a, p);
    const [fb] = scanText('key: ' + b, p);
    expect(fa!.kind).toBe(fb!.kind);
    expect(fa!.fingerprint).not.toBe(fb!.fingerprint);
    const allow = [{ fingerprint: fa!.fingerprint, reason: 'documented example, revoked', by: 'human:me', at: '2026-09-09T00:00:00Z' }];
    // allow-listed → suppressed
    expect(scanText('key: ' + a, p, { allow })).toEqual([]);
    // value replaced by another of identical length → finding returns
    expect(scanText('key: ' + b, p, { allow })).toHaveLength(1);
    // same value moved to another line → still suppressed
    expect(scanText('# intro\n\nnotes\nkey: ' + a, p, { allow })).toEqual([]);
    expect(JSON.stringify([fa, fb])).not.toContain(a);
    expect(JSON.stringify([fa, fb])).not.toContain(b);
  });

  it('inline allow-secret with a non-empty reason suppresses the next line only', () => {
    const secret = 'key: sk_live_' + rep('4eC3', 6);
    expect(scanText('<!-- thoughts:allow-secret reason="doc example" -->\n' + secret, '/a.md')).toEqual([]);
    expect(scanText('<!-- thoughts:allow-secret reason="" -->\n' + secret, '/a.md')).toHaveLength(1);
    expect(scanText('<!-- thoughts:allow-secret -->\n' + secret, '/a.md')).toHaveLength(1);
    expect(scanText('<!-- thoughts:allow-secret reason="x" -->\n\n' + secret, '/a.md')).toHaveLength(1);
    const two = scanText('<!-- thoughts:allow-secret reason="x" -->\n' + secret + '\n' + secret, '/a.md');
    expect(two.map((f) => f.line)).toEqual([3]);
  });
});

describe('scanText details', () => {
  it('reports 1-based lines, handles CRLF, and orders findings by line then column', () => {
    const text = 'intro\r\nfirst: ghp_' + rep('a', 36) + ' and AKIA' + rep('A1B2', 4) + '\r\n\r\nlast: glpat-' + rep('b', 20) + '\r\n';
    const findings = scanText(text, '/a.md');
    expect(findings.map((f) => [f.line, f.kind])).toEqual([
      [2, 'github token'],
      [2, 'aws access key'],
      [4, 'gitlab token'],
    ]);
  });

  it('uses the display path verbatim (e.g. --set keys) and carries it into the fingerprint', () => {
    const tok = 'ghp_' + rep('a', 36);
    const f = one(tok) as Finding;
    const g = scanText(tok, '--set token')[0] as Finding;
    expect(g.path).toBe('--set token');
    expect(g.fingerprint).not.toBe(f.fingerprint);
    expect(g.fingerprint).toBe(fingerprint('--set token', 'github token', g.masked, tok));
  });

  it('returns nothing for ordinary prose and empty input', () => {
    expect(scanText('', '/a.md')).toEqual([]);
    expect(scanText('# Refund endpoint v2\n\nWe use Stripe for refunds. Keys live in the vault.\n', '/a.md')).toEqual([]);
  });

  it('entropy is off by default and warns when enabled', () => {
    const noisy = 'id: "' + 'aZ9!bY8@cX7#dW6$eV5%fU4^' + '"';
    expect(scanText(noisy, '/a.md')).toEqual([]);
    const on = scanText(noisy, '/a.md', { entropy: true });
    expect(on.map((f) => [f.kind, f.severity])).toEqual([['high entropy string', 'warn']]);
    expect(hasBlocking(on)).toBe(false);
    expect(scanText('note: "' + rep('a', 30) + '"', '/a.md', { entropy: true })).toEqual([]);
  });
});
