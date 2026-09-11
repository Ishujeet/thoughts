import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAsset } from '../../src/assets.js';
import { BUILTIN_TEMPLATE_NAMES, resetTemplateWarnings, resolveTemplate } from '../../src/templates/resolve.js';
import { DEFAULT_KINDS, ExitCode, type BrainConfig } from '../../src/types.js';
import { capture, cleanupMachines, expectThoughtsError, makeMachine, write, type Captured } from '../commands/helpers.js';

function brain(source: BrainConfig['templates']['source']): BrainConfig {
  return { name: 'acme', kind: 'project', okf_version: '0.2', kinds: DEFAULT_KINDS, templates: { source }, repos: [] };
}

let root: string;
let cap: Captured;
beforeEach(async () => {
  root = (await makeMachine('tpl')).root;
  resetTemplateWarnings();
  cap = capture();
});
afterEach(async () => {
  cap.restore();
  await cleanupMachines();
});

describe('resolveTemplate', () => {
  it('lists the six built-in templates', () => {
    expect([...BUILTIN_TEMPLATE_NAMES].sort()).toEqual(['commit', 'decision', 'plan', 'pr', 'research', 'spec']);
  });

  it('builtin source reads the embedded asset', async () => {
    const r = await resolveTemplate('plan', { brainRoot: root, brain: brain('builtin') });
    expect(r.source).toBe('builtin');
    expect(r.content).toBe(readAsset('templates', 'plan.md'));
  });

  it('--template <path> wins over everything', async () => {
    const abs = path.join(root, 'mine.md');
    write(abs, '# custom {{title}}\n');
    const r = await resolveTemplate('plan', { brainRoot: root, brain: brain('brain'), override: 'mine.md', cwd: root });
    expect(r).toEqual({ content: '# custom {{title}}\n', path: abs, source: 'override' });
    const e = await expectThoughtsError(() => resolveTemplate('plan', { override: path.join(root, 'missing.md') }));
    expect(e.exitCode).toBe(ExitCode.Validation);
  });

  it('brain source reads <brain>/templates/<name>.md and falls back to builtin with one warning', async () => {
    const brainRoot = path.join(root, 'b');
    write(path.join(brainRoot, 'templates', 'spec.md'), 'org spec {{title}}\n');
    const hit = await resolveTemplate('spec', { brainRoot, brain: brain('brain') });
    expect(hit.source).toBe('brain');
    expect(hit.path).toBe(path.join(brainRoot, 'templates', 'spec.md'));
    const miss = await resolveTemplate('plan', { brainRoot, brain: brain('brain') });
    expect(miss.source).toBe('builtin');
    await resolveTemplate('plan', { brainRoot, brain: brain('brain') });
    const warnings = cap.stderr.filter((l) => l.includes('no plan.md'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('using the built-in template');
  });

  it('path:<dir> source reads <dir>/<name>.md', async () => {
    const dir = path.join(root, 'org-templates');
    write(path.join(dir, 'decision.md'), 'adr {{title}}\n');
    const r = await resolveTemplate('decision', { brainRoot: root, brain: brain(`path:${dir}`) });
    expect(r.source).toBe('path');
    expect(r.content).toBe('adr {{title}}\n');
  });

  it('git:<url> source is cloned into the templates cache', async () => {
    const src = path.join(root, 'tpl-src');
    write(path.join(src, 'research.md'), 'git research {{title}}\n');
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', src]);
    execFileSync('git', ['-C', src, 'add', '-A']);
    execFileSync('git', ['-C', src, 'commit', '-q', '-m', 'init']);
    const r = await resolveTemplate('research', { brainRoot: root, brain: brain(`git:${src}`) });
    expect(r.source).toBe('git');
    expect(r.content).toBe('git research {{title}}\n');
    expect(r.path.startsWith(path.join(root, '.thoughts', 'templates'))).toBe(true);
  });

  it('unknown template with no builtin is a Validation error', async () => {
    const e = await expectThoughtsError(() => resolveTemplate('rfc', { brainRoot: root, brain: brain('builtin') }));
    expect(e.exitCode).toBe(ExitCode.Validation);
    expect(e.message).toContain('unknown template "rfc"');
    expect(fs.existsSync(path.join(root, '.thoughts'))).toBe(false);
  });
});
