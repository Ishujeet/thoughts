import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldBrain } from '../../src/brain/layout.js';
import { formatIssues, hasErrors, lintBrain } from '../../src/brain/lint.js';
import { DEFAULT_KINDS, type BrainConfig, type LintIssue } from '../../src/types.js';
import { concept, makeTempEnv, writeFile, type TempEnv } from './helpers.js';

let env: TempEnv;
beforeEach(async () => {
  env = await makeTempEnv();
});
afterEach(async () => {
  await env.restore();
});

const brain: BrainConfig = { okf_version: '0.2', kind: 'project', name: 'b', repos: [], kinds: DEFAULT_KINDS, templates: { source: 'builtin' } };

describe('lintBrain', () => {
  it('combines validateThought with layout and link rules', async () => {
    const root = path.join(env.root, 'brain');
    await scaffoldBrain(root, { name: 'b' });
    await writeFile(root, 'repos/svc/specs/2026-09-08-ok.md', concept({ title: 'OK', repo: 'svc' }));
    await writeFile(root, 'repos/svc/specs/2026-09-08-bad.md', '# no frontmatter\n');
    await writeFile(
      root,
      'shared/decisions/2026-09-01-d.md',
      concept({
        title: 'D',
        repo: 'shared',
        extra: [
          'supersedes: /shared/decisions/missing.md',
          'superseded_by: /repos/svc/specs/2026-09-08-ok.md',
          'sources:',
          '  - resource: /shared/nope.md',
          '  - resource: https://example.com/external',
          '  - resource: /repos/svc/specs/2026-09-08-ok.md#section',
        ].join('\n'),
      }),
    );
    await fs.promises.mkdir(path.join(root, 'repos', 'svc', 'templates'), { recursive: true });
    await writeFile(root, 'repos/svc/templates/plan.md', 'x');

    const issues = await lintBrain(root, brain);
    const byRule = (rule: string): LintIssue[] => issues.filter((i) => i.rule === rule);
    expect(byRule('okf/frontmatter')).toMatchObject([{ severity: 'error', path: '/repos/svc/specs/2026-09-08-bad.md', line: 1 }]);
    expect(byRule('okf/broken-link').map((i) => i.message)).toEqual([
      'sources[0].resource points to /shared/nope.md which does not exist in the bundle',
      'supersedes points to /shared/decisions/missing.md which does not exist in the bundle',
    ]);
    expect(byRule('okf/broken-link').every((i) => i.severity === 'warning' && i.path === '/shared/decisions/2026-09-01-d.md')).toBe(true);
    expect(byRule('layout/repo-templates')).toMatchObject([{ severity: 'error', path: '/repos/svc/templates' }]);
    expect(hasErrors(issues)).toBe(true);
  });

  it('is clean for a valid brain', async () => {
    const root = path.join(env.root, 'brain');
    await scaffoldBrain(root, { name: 'b' });
    await writeFile(root, 'shared/specs/2026-09-08-a.md', concept({ title: 'A', repo: 'shared', description: 'd', status: 'stable' }));
    const issues = await lintBrain(root, brain);
    expect(issues).toEqual([]);
    expect(hasErrors(issues)).toBe(false);
  });
});

describe('formatIssues / hasErrors', () => {
  it('formats path:line: severity: message (rule), omitting :line when unknown', () => {
    const issues: LintIssue[] = [
      { severity: 'error', path: '/repos/svc/specs/a.md', line: 3, rule: 'okf/missing-field', message: 'title missing' },
      { severity: 'warning', path: '/shared/decisions/d.md', rule: 'okf/broken-link', message: 'supersedes points to /x which does not exist in the bundle' },
    ];
    expect(formatIssues(issues)).toBe(
      '/repos/svc/specs/a.md:3: error: title missing (okf/missing-field)\n/shared/decisions/d.md: warning: supersedes points to /x which does not exist in the bundle (okf/broken-link)',
    );
    expect(formatIssues([])).toBe('');
    expect(hasErrors(issues)).toBe(true);
    expect(hasErrors([issues[1] as LintIssue])).toBe(false);
  });
});
