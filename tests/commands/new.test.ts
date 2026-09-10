/** `thoughts new` (specs/06 acceptance criteria). */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, parseThought, validateThought } from '../../src/brain/okf.js';
import { runInit } from '../../src/commands/init.js';
import { parseSetValues, resolveKind, runNew, yamlDoubleQuoteEscape } from '../../src/commands/new.js';
import { resetTemplateWarnings } from '../../src/templates/resolve.js';
import { DEFAULT_KINDS, ExitCode, SecretFoundError } from '../../src/types.js';
import { capture, cleanupMachines, expectThoughtsError, fakeGithubToken, makeCodeRepo, makeMachine, read, write, type Captured, type Machine } from './helpers.js';

let m: Machine;
let cap: Captured;
let repo: string;
let brain: string;
const now = new Date('2026-09-09T10:30:00Z');

beforeEach(async () => {
  m = await makeMachine('new');
  cap = capture();
  resetTemplateWarnings();
  repo = await makeCodeRepo(path.join(m.root, 'payments-api'));
  brain = (await runInit({ yes: true, brain: path.join(m.root, 'acme-brain') }, repo)).brainRoot;
  cap.stdout.length = 0;
  cap.stderr.length = 0;
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

describe('new: happy paths', () => {
  it('creates repos/payments-api/specs/<date>-x.md with valid OKF frontmatter and status draft', async () => {
    const r = await runNew('spec', 'X', { now }, repo);
    expect(r).toMatchObject({ path: '/repos/payments-api/specs/2026-09-09-x.md', kind: 'specs', type: 'Spec', template: 'spec' });
    expect(r.absPath).toBe(path.join(brain, 'repos/payments-api/specs/2026-09-09-x.md'));
    const t = await parseThought(r.absPath, r.path);
    expect(t.frontmatter).toMatchObject({ type: 'Spec', title: 'X', status: 'draft', repo: 'payments-api', tags: [], sources: [] });
    expect(t.frontmatter.generated).toMatchObject({ at: '2026-09-09T10:30:00Z' });
    expect(String(t.frontmatter.generated?.by)).toMatch(/^human:/);
    expect(validateThought(t).filter((i) => i.severity === 'error')).toEqual([]);
    expect(read(r.absPath)).toContain('# X\n');
    expect(read(r.absPath)).toContain('## Cross-repo impact');
    // The bundle-relative path is always printed.
    expect(cap.stdout.join('')).toBe('/repos/payments-api/specs/2026-09-09-x.md\n');
    // branch/commit come from the code repo.
    expect(read(r.absPath)).toMatch(/branch: (master|main)\n/);
  });

  it('same title twice → -2 suffix, then -3', async () => {
    await runNew('spec', 'Refund endpoint v2', { now }, repo);
    const second = await runNew('spec', 'Refund endpoint v2', { now }, repo);
    expect(second.path).toBe('/repos/payments-api/specs/2026-09-09-refund-endpoint-v2-2.md');
    const third = await runNew('spec', 'Refund endpoint v2', { now }, repo);
    expect(third.path).toBe('/repos/payments-api/specs/2026-09-09-refund-endpoint-v2-3.md');
  });

  it('accepts the kind by directory name, template name, or singular', () => {
    expect(resolveKind(DEFAULT_KINDS, 'specs')).toBe('specs');
    expect(resolveKind(DEFAULT_KINDS, 'spec')).toBe('specs');
    expect(resolveKind(DEFAULT_KINDS, 'pr')).toBe('prs');
    expect(resolveKind(DEFAULT_KINDS, 'research')).toBe('research');
    expect(resolveKind({ rfcs: { template: 'rfc' } }, 'rfc')).toBe('rfcs');
    expect(resolveKind(DEFAULT_KINDS, 'nope')).toBeUndefined();
  });

  it('--set foo=bar on a template that does not use foo is a warning, not an error', async () => {
    const r = await runNew('plan', 'Warn me', { set: ['foo=bar', 'ticket=CHK-1'], now }, repo);
    expect(fs.existsSync(r.absPath)).toBe(true);
    expect(r.warnings.some((w) => w.includes('--set foo is not used'))).toBe(true);
    expect(cap.stderr.join('')).toContain('warning: --set foo is not used by template plan.md');
    expect(read(r.absPath)).toContain('ticket: CHK-1');
  });

  it('keeps & unescaped and quotes titles with YAML-special characters', async () => {
    const r = await runNew('decision', 'Retry & backoff: "v2" \\ done', { now }, repo);
    const fm = parseFrontmatter(read(r.absPath));
    expect(fm.error).toBeUndefined();
    expect(fm.frontmatter.title).toBe('Retry & backoff: "v2" \\ done');
    expect(r.path).toBe('/repos/payments-api/decisions/2026-09-09-retry-backoff-v2-done.md');
    expect(yamlDoubleQuoteEscape('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it('--shared and --user pick the zone; --json prints only the structured result', async () => {
    const s = await runNew('decision', 'Shared one', { shared: true, json: true, now }, repo);
    expect(s.path).toBe('/shared/decisions/2026-09-09-shared-one.md');
    expect(JSON.parse(cap.stdout.join(''))).toEqual({ path: s.path, absPath: s.absPath, kind: 'decisions', type: 'Decision', template: 'decision' });
    expect(parseFrontmatter(read(s.absPath)).frontmatter.repo).toBe('shared');
    const u = await runNew('research', 'Mine', { user: true, now }, repo);
    expect(u.path).toMatch(/^\/users\/[^/]+\/research\/2026-09-09-mine\.md$/);
    expect(String(parseFrontmatter(read(u.absPath)).frontmatter.repo)).toMatch(/^user:/);
  });

  it('--from links the source and pre-fills a PR from a plan; title may come from --from', async () => {
    const plan = await runNew('plan', 'Refunds', { now }, repo);
    write(plan.absPath, read(plan.absPath).replace('description: ', 'description: Refund everything'));
    const pr = await runNew('pr', undefined, { from: plan.path.slice(1), now }, repo);
    expect(pr.path).toBe('/repos/payments-api/prs/2026-09-09-refunds.md');
    const text = read(pr.absPath);
    const fm = parseFrontmatter(text);
    expect(fm.frontmatter.sources).toEqual([{ resource: plan.path, title: 'Refunds' }]);
    expect(fm.frontmatter.type).toBe('Pull Request');
    expect(text).toContain('Refund everything');
    expect(text).toContain('- Source: ' + plan.path);
    // Also accepted as a bundle path with leading slash.
    const pr2 = await runNew('pr', 'Second', { from: plan.path, now }, repo);
    expect(parseFrontmatter(read(pr2.absPath)).frontmatter.sources).toEqual([{ resource: plan.path, title: 'Refunds' }]);
  });

  it('--template <path> overrides the source; does not sync', async () => {
    const tpl = path.join(m.root, 'custom.md');
    write(tpl, '---\ntype: {{type}}\ntitle: "{{title}}"\nstatus: draft\nrepo: {{repo_id}}\ngenerated:\n  by: {{author}}\n  at: {{now}}\n---\n# {{upper title}} in {{brain_name}}\n');
    const r = await runNew('spec', 'custom', { template: tpl, now }, repo);
    expect(read(r.absPath)).toContain('# CUSTOM in acme-brain');
    await expect((await import('../../src/git.js')).statusPorcelain(brain).then((s) => s.length)).resolves.toBeGreaterThan(0);
  });
});

describe('new: failure paths', () => {
  it('--set token=ghp_… is refused (exit 7), nothing written, value masked', async () => {
    const token = fakeGithubToken();
    const before = fs.readdirSync(path.join(brain, 'repos', 'payments-api', 'research'));
    let caught: unknown;
    try {
      await runNew('research', 'Leak test', { set: ['token=' + token], now }, repo);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SecretFoundError);
    const e = caught as SecretFoundError;
    expect(e.exitCode).toBe(ExitCode.SecretFound);
    expect(e.findings[0]).toMatchObject({ path: '--set token', kind: 'github token', masked: 'ghp_' + '*'.repeat(16) });
    expect(e.message + JSON.stringify(e.findings)).not.toContain(token);
    expect(fs.readdirSync(path.join(brain, 'repos', 'payments-api', 'research'))).toEqual(before);
  });

  it('a secret in the rendered file (via --template) is refused before writing', async () => {
    const tpl = path.join(m.root, 'leaky.md');
    write(tpl, '---\ntype: {{type}}\ntitle: "{{title}}"\n---\nkey: sk_live_' + 'c'.repeat(24) + '\n');
    const e = await expectThoughtsError(() => runNew('spec', 'Leaky', { template: tpl, now }, repo));
    expect(e.exitCode).toBe(ExitCode.SecretFound);
    expect(fs.existsSync(path.join(brain, 'repos/payments-api/specs/2026-09-09-leaky.md'))).toBe(false);
  });

  it('template rendering errors name the template file and line', async () => {
    const tpl = path.join(m.root, 'bad.md');
    write(tpl, '---\ntitle: {{title}}\n---\n\n{{> partial}}\n');
    const e = await expectThoughtsError(() => runNew('spec', 'Bad', { template: tpl, now }, repo));
    expect(e.exitCode).toBe(ExitCode.Validation);
    expect(e.message).toBe(`${tpl}:5: partials are not allowed`);
  });

  it('unknown kind lists the kinds; outside a repo --repo or --shared is required', async () => {
    const e = await expectThoughtsError(() => runNew('rfc', 'X', { now }, repo));
    expect(e.exitCode).toBe(ExitCode.Validation);
    expect(e.hint).toContain('plans, specs, research, decisions, prs');
    const outside = await expectThoughtsError(() => runNew('spec', 'X', { now }, brain));
    expect(outside.exitCode).toBe(ExitCode.Validation);
    expect(outside.hint).toContain('--repo');
    const viaRepo = await runNew('spec', 'X', { repo: 'payments-api', now }, brain);
    expect(viaRepo.path).toBe('/repos/payments-api/specs/2026-09-09-x.md');
    expect((await expectThoughtsError(() => runNew('spec', 'X', { shared: true, repo: 'a', now }, repo))).exitCode).toBe(ExitCode.Validation);
    expect((await expectThoughtsError(() => runNew('spec', '', { now }, repo))).exitCode).toBe(ExitCode.Validation);
    expect((await expectThoughtsError(() => runNew('spec', 'X', { from: 'repos/nope.md', now }, repo))).exitCode).toBe(ExitCode.Validation);
  });

  it('rejects malformed --set values', () => {
    expect(parseSetValues(['a=1', 'b.c=x=y'])).toEqual({ a: '1', 'b.c': 'x=y' });
    expect(() => parseSetValues(['novalue'])).toThrow(/invalid --set value/);
    expect(() => parseSetValues(['=x'])).toThrow(/invalid --set value/);
  });
});
