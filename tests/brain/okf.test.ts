import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, parseThought, serializeThought, trustTier, validateThought } from '../../src/brain/okf.js';
import { ExitCode, type Frontmatter, type Thought } from '../../src/types.js';
import { concept, makeTempEnv, writeFile, type TempEnv } from './helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

describe('parseFrontmatter', () => {
  it('parses a block with LF and CRLF, keeping the body verbatim', () => {
    const lf = parseFrontmatter('---\ntitle: X\ncustom: 1\n---\n# Body\n');
    expect(lf.hasFrontmatter).toBe(true);
    expect(lf.frontmatter).toEqual({ title: 'X', custom: 1 });
    expect(lf.body).toBe('# Body\n');
    expect(lf.raw).toBe('title: X\ncustom: 1\n');
    const crlf = parseFrontmatter('---\r\ntitle: X\r\n---\r\nbody\r\n');
    expect(crlf.hasFrontmatter).toBe(true);
    expect(crlf.frontmatter).toEqual({ title: 'X' });
    expect(crlf.body).toBe('body\r\n');
  });

  it('handles missing, empty, unparsable and non-mapping blocks without throwing', () => {
    const none = parseFrontmatter('# Just markdown\n---\nnot frontmatter\n');
    expect(none.hasFrontmatter).toBe(false);
    expect(none.body).toBe('# Just markdown\n---\nnot frontmatter\n');
    expect(none.error).toBeUndefined();

    const empty = parseFrontmatter('---\n---\nbody');
    expect(empty.hasFrontmatter).toBe(true);
    expect(empty.frontmatter).toEqual({});
    expect(empty.body).toBe('body');

    const bad = parseFrontmatter('---\ntitle: [unclosed\n---\nbody\n');
    expect(bad.hasFrontmatter).toBe(false);
    expect(bad.error).toBeTruthy();
    expect(bad.body).toBe('body\n');

    const scalar = parseFrontmatter('---\njust a string\n---\nbody\n');
    expect(scalar.hasFrontmatter).toBe(false);
    expect(scalar.error).toMatch(/mapping/);

    const unclosed = parseFrontmatter('---\ntitle: x\nno end');
    expect(unclosed.hasFrontmatter).toBe(false);
    expect(unclosed.error).toMatch(/closing/);
  });

  it('does not treat a fence inside the body as the close of a block that has none', () => {
    const p = parseFrontmatter('intro\n---\ntitle: x\n---\n');
    expect(p.hasFrontmatter).toBe(false);
  });
});

describe('serializeThought', () => {
  it('round-trips unknown keys, nested objects and the body byte for byte', () => {
    const fm: Frontmatter = {
      type: 'Spec',
      title: 'Refund endpoint v2',
      status: 'draft',
      generated: { by: 'human:me', at: '2026-09-08T10:00:00Z' },
      repo: 'payments-api',
      okf_version_like: '0.2',
      links: { ticket: 'CHK-1', custom: ['a', 'b'] },
      nested: { deep: { list: [1, 2, { x: 'y' }] } },
      'weird key': 'value: with colon',
    };
    const body = '# Title\n\nSome *markdown*\n\n---\n\nnot frontmatter\n';
    const text = serializeThought(fm, body);
    expect(text.startsWith('---\ntype: Spec\n')).toBe(true);
    const back = parseFrontmatter(text);
    expect(back.hasFrontmatter).toBe(true);
    expect(back.frontmatter).toEqual(fm);
    expect(back.body).toBe(body);
    expect(Object.keys(back.frontmatter)).toEqual(Object.keys(fm));
    // and again
    expect(serializeThought(back.frontmatter, back.body)).toBe(text);
  });

  it('serialises an empty frontmatter as an empty block', () => {
    expect(serializeThought({}, 'b')).toBe('---\n---\nb');
  });
});

describe('parseThought', () => {
  it('reads a file and locates it; rejects non-zone paths', async () => {
    const rel = '/repos/svc/specs/2026-09-08-a.md';
    const abs = await writeFile(env.root, rel.slice(1), concept({ title: 'A', repo: 'svc' }));
    const t = await parseThought(abs, rel);
    expect(t.location).toMatchObject({ zone: 'repos', owner: 'svc', kind: 'specs', date: '2026-09-08' });
    expect(t.frontmatter.title).toBe('A');
    expect(t.hasFrontmatter).toBe(true);
    expect(t.rawFrontmatter).toContain('title: A');
    expect(t.absPath).toBe(abs);
    await expect(parseThought(abs, '/templates/x.md')).rejects.toMatchObject({ exitCode: ExitCode.Validation });
  });
});

function thoughtFrom(text: string, rel: string): Thought {
  const parsed = parseFrontmatter(text);
  const t: Thought = {
    location: { path: rel, zone: rel.startsWith('/shared') ? 'shared' : rel.startsWith('/users') ? 'users' : 'repos' },
    absPath: path.join('/nowhere', rel),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    hasFrontmatter: parsed.hasFrontmatter,
  };
  if (t.location.zone !== 'shared') t.location.owner = rel.split('/')[2];
  if (parsed.raw !== undefined) t.rawFrontmatter = parsed.raw;
  return t;
}

describe('validateThought', () => {
  const rules = (t: Thought, now?: Date): string[] => validateThought(t, now ? { now } : {}).map((i) => i.severity[0] + ':' + i.rule);

  it('accepts a valid thought', () => {
    expect(validateThought(thoughtFrom(concept({ title: 'A', repo: 'svc' }), '/repos/svc/specs/a.md'))).toEqual([]);
    expect(validateThought(thoughtFrom(concept({ title: 'A', repo: 'shared' }), '/shared/specs/a.md'))).toEqual([]);
    expect(validateThought(thoughtFrom(concept({ title: 'A', repo: 'user:me' }), '/users/me/plans/a.md'))).toEqual([]);
  });

  it('E okf/frontmatter for missing or unparsable frontmatter, at line 1', () => {
    const missing = validateThought(thoughtFrom('# nothing\n', '/shared/specs/a.md'));
    expect(missing).toEqual([{ severity: 'error', path: '/shared/specs/a.md', line: 1, rule: 'okf/frontmatter', message: 'frontmatter missing' }]);
    const bad = validateThought(thoughtFrom('---\ntitle: [x\n---\n', '/shared/specs/a.md'));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ severity: 'error', rule: 'okf/frontmatter', line: 1 });
    expect(bad[0]?.message).toMatch(/unparsable/);
  });

  it('E okf/missing-field for each required field, including generated.by/at', () => {
    const issues = validateThought(thoughtFrom('---\ndescription: d\n---\n', '/shared/specs/a.md'));
    const missing = issues.filter((i) => i.rule === 'okf/missing-field').map((i) => i.message);
    expect(missing).toEqual(['type missing', 'title missing', 'status missing', 'generated missing', 'repo missing']);
    const partial = validateThought(thoughtFrom('---\ntype: Spec\ntitle: t\nstatus: draft\nrepo: shared\ngenerated:\n  by: human:x\n---\n', '/shared/specs/a.md'));
    expect(partial.map((i) => i.message)).toEqual(['generated.at missing']);
  });

  it('E okf/bad-status names the allowed values; unknown type is tolerated', () => {
    const t = thoughtFrom(concept({ title: 'A', repo: 'shared', status: 'final', type: 'Runbook' }), '/shared/specs/a.md');
    const issues = validateThought(t);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', rule: 'okf/bad-status', line: 4 });
    expect(issues[0]?.message).toContain('draft, stable, deprecated');
  });

  it('E okf/repo-mismatch when repo disagrees with the zone', () => {
    expect(rules(thoughtFrom(concept({ title: 'A', repo: 'other' }), '/repos/svc/specs/a.md'))).toEqual(['e:okf/repo-mismatch']);
    expect(rules(thoughtFrom(concept({ title: 'A', repo: 'svc' }), '/shared/specs/a.md'))).toEqual(['e:okf/repo-mismatch']);
    expect(rules(thoughtFrom(concept({ title: 'A', repo: 'me' }), '/users/me/specs/a.md'))).toEqual(['e:okf/repo-mismatch']);
    const issue = validateThought(thoughtFrom(concept({ title: 'A', repo: 'me' }), '/users/me/specs/a.md'))[0];
    expect(issue?.message).toContain('user:me');
    expect(issue?.line).toBe(8);
  });

  it('W okf/empty-description on stable, W okf/stale when stale_after is past and not deprecated', () => {
    expect(rules(thoughtFrom(concept({ title: 'A', repo: 'shared', status: 'stable' }), '/shared/specs/a.md'))).toEqual(['w:okf/empty-description']);
    expect(rules(thoughtFrom(concept({ title: 'A', repo: 'shared', status: 'stable', description: '' }), '/shared/specs/a.md'))).toEqual(['w:okf/empty-description']);
    expect(rules(thoughtFrom(concept({ title: 'A', repo: 'shared', status: 'draft' }), '/shared/specs/a.md'))).toEqual([]);

    const now = new Date('2026-09-09T00:00:00Z');
    const stale = concept({ title: 'A', repo: 'shared', description: 'd', status: 'stable', extra: 'stale_after: 2026-01-01' });
    expect(rules(thoughtFrom(stale, '/shared/specs/a.md'), now)).toEqual(['w:okf/stale']);
    const fresh = concept({ title: 'A', repo: 'shared', description: 'd', status: 'stable', extra: 'stale_after: 2027-01-01' });
    expect(rules(thoughtFrom(fresh, '/shared/specs/a.md'), now)).toEqual([]);
    const deprecated = concept({ title: 'A', repo: 'shared', status: 'deprecated', extra: 'stale_after: 2026-01-01' });
    expect(rules(thoughtFrom(deprecated, '/shared/specs/a.md'), now)).toEqual([]);
  });
});

describe('trustTier', () => {
  it('follows the OKF table', () => {
    expect(trustTier({})).toBe('unverified');
    expect(trustTier({ verified: [] })).toBe('unverified');
    expect(trustTier({ verified: [{ by: 'claude-code/x', at: 't' }] })).toBe('machine-confirmed');
    expect(trustTier({ verified: [{ by: 'process:ci', at: 't' }, { by: 'human:me', at: 't' }] })).toBe('human-reviewed');
  });
});
