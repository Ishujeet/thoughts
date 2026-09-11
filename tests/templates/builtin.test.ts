/** The six built-in templates (specs/07 "Built-in templates"). */
import { describe, expect, it } from 'vitest';
import { readAsset } from '../../src/assets.js';
import { parseFrontmatter } from '../../src/brain/okf.js';
import { renderTemplate } from '../../src/templates/render.js';
import { BUILTIN_TYPES } from '../../src/types.js';

const SECTIONS: Record<string, string[]> = {
  plan: ['Goal', 'Context', 'Approach', 'Steps', 'Risks & dependencies', 'Done when', 'Out of scope'],
  spec: ['Summary', 'Motivation', 'Interface', 'Behaviour', 'Cross-repo impact', 'Migration / rollout', 'Acceptance criteria', 'Open questions'],
  research: ['Question', 'What I looked at', 'Findings', 'Recommendation', 'Confidence', 'Follow-ups'],
  decision: ['Status', 'Context', 'Decision', 'Consequences', 'Affected repos', 'Alternatives considered'],
  pr: ['Summary', 'Why', 'What changed', 'Cross-repo notes', 'Testing', 'Checklist'],
};

const vars = {
  title: 'Refund & retry "v2"',
  slug: 'refund-retry-v2',
  date: '2026-09-09',
  now: '2026-09-09T10:00:00Z',
  kind: 'specs',
  type: 'Spec',
  repo_id: 'payments-api',
  brain_name: 'acme',
  author: 'human:qa',
};

describe('built-in templates', () => {
  for (const [name, sections] of Object.entries(SECTIONS)) {
    it(`${name}.md has the specs/07 frontmatter skeleton and sections`, () => {
      const content = readAsset('templates', name + '.md');
      const type = BUILTIN_TYPES[name]!;
      // `title` is passed pre-escaped for the YAML double-quoted scalar (see src/commands/new.ts).
      const { output, missingVars } = renderTemplate(content, { ...vars, type, title: vars.title.replace(/"/g, '\\"') }, { templatePath: name });
      const parsed = parseFrontmatter(output);
      expect(parsed.error).toBeUndefined();
      expect(parsed.hasFrontmatter).toBe(true);
      const fm = parsed.frontmatter;
      expect(fm.type).toBe(type);
      expect(fm.title).toBe('Refund & retry "v2"');
      expect(fm.status).toBe('draft');
      expect(fm.repo).toBe('payments-api');
      expect(fm.tags).toEqual([]);
      expect(fm.sources).toEqual([]);
      expect(fm.generated).toEqual({ by: 'human:qa', at: '2026-09-09T10:00:00Z' });
      expect(fm['links']).toMatchObject({});
      for (const s of sections) expect(output).toContain(`## ${s}`);
      // Only optional variables may be missing.
      const unexpected = missingVars.filter((v) => !['ticket', 'pr', 'branch', 'from'].includes(v.split('.')[0]!));
      expect(unexpected).toEqual([]);
      expect(output).toContain('& retry');
    });
  }

  it('pr.md pulls title and summary from --from', () => {
    const content = readAsset('templates', 'pr.md');
    const { output } = renderTemplate(content, { ...vars, type: 'Pull Request', from: { path: '/repos/payments-api/plans/x.md', title: 'Plan X', description: 'Desc X' } }, { templatePath: 'pr' });
    expect(output).toContain('Plan X');
    expect(output).toContain('Desc X');
    expect(output).toContain('/repos/payments-api/plans/x.md');
  });

  it('commit.md is a three-part message template', () => {
    const content = readAsset('templates', 'commit.md');
    const { output } = renderTemplate(content, { ...vars, ticket: 'CHK-1' }, { templatePath: 'commit' });
    const lines = output.split('\n');
    expect(lines[0]).toBe('payments-api: Refund & retry "v2"');
    expect(lines[1]).toBe('');
    expect(output).toMatch(/Refs: CHK-1 · Plan: .* · Spec: /);
  });
});
