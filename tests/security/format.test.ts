import { describe, expect, it } from 'vitest';
import { formatFindings } from '../../src/security/format.js';
import { fingerprint, scanText } from '../../src/security/scanner.js';
import type { Finding } from '../../src/types.js';

const rep = (s: string, n: number): string => s.repeat(n);

function findings(): Finding[] {
  const stripe = scanText('note\n'.repeat(40) + 'key: sk_live_' + rep('4eC3', 6) + '\n', '/repos/payments-api/research/2026-09-08-stripe-webhooks.md');
  const conn = scanText('x\n'.repeat(17) + 'url: postgres://app:' + rep('pw', 8) + '@db.internal:5432/orders\n', '/shared/decisions/2026-09-01-db-access.md');
  return [...stripe, ...conn];
}

describe('formatFindings', () => {
  it('matches the specs/15 "Output" block byte for byte (with the contract mask)', () => {
    const out = formatFindings(findings());
    expect(out).toBe(
      [
        '✗ secret found — refusing to commit',
        '',
        '  repos/payments-api/research/2026-09-08-stripe-webhooks.md:41',
        '    stripe secret key      sk_l' + rep('*', 16),
        '  shared/decisions/2026-09-01-db-access.md:18',
        '    connection string      postgres://app:****@db.internal:5432/orders',
        '',
        'Fix:  edit the lines above, or run   thoughts scan --fix   to redact them.',
        'Then: rotate any real credential that was exposed. Scanning does not un-leak it.',
      ].join('\n'),
    );
    expect(out).not.toContain('4eC3');
    expect(out).not.toContain(rep('pw', 8));
  });

  it('uses the given verb, and shows line-0 findings without a :line suffix', () => {
    const blocked: Finding = {
      path: '/repos/svc/research/.env',
      line: 0,
      kind: 'blocked filename',
      severity: 'block',
      masked: '',
      fingerprint: fingerprint('/repos/svc/research/.env', 'blocked filename', '', ''),
    };
    const out = formatFindings([blocked], { verb: 'create' });
    expect(out.split('\n').slice(0, 4)).toEqual(['✗ secret found — refusing to create', '', '  repos/svc/research/.env', '    blocked filename       ']);
  });

  it('json form is a JSON array of { path, line, kind, severity, masked, fingerprint } and nothing else', () => {
    const list = findings();
    const parsed = JSON.parse(formatFindings(list, { json: true })) as Record<string, unknown>[];
    expect(parsed).toHaveLength(2);
    for (const [i, item] of parsed.entries()) {
      expect(Object.keys(item).sort()).toEqual(['fingerprint', 'kind', 'line', 'masked', 'path', 'severity']);
      expect(item).toEqual({
        path: list[i]!.path,
        line: list[i]!.line,
        kind: list[i]!.kind,
        severity: list[i]!.severity,
        masked: list[i]!.masked,
        fingerprint: list[i]!.fingerprint,
      });
    }
    expect(JSON.parse(formatFindings([], { json: true }))).toEqual([]);
  });
});
