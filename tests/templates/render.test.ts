import { describe, expect, it } from 'vitest';
import { renderTemplate, slugify } from '../../src/templates/render.js';
import { ExitCode, ThoughtsError } from '../../src/types.js';

const tpl = 'x.md';

function fails(content: string, vars: Record<string, unknown> = {}): ThoughtsError {
  try {
    renderTemplate(content, vars, { templatePath: tpl });
  } catch (err) {
    if (err instanceof ThoughtsError) return err;
    throw err;
  }
  throw new Error('expected a ThoughtsError');
}

describe('renderTemplate: allowed subset', () => {
  it('substitutes {{var}} and {{object.field}}', () => {
    const r = renderTemplate('# {{title}}\n{{from.title}} {{from.path}}', { title: 'T', from: { title: 'F', path: '/p' } }, { templatePath: tpl });
    expect(r.output).toBe('# T\nF /p');
    expect(r.missingVars).toEqual([]);
  });

  it('supports #if/else and #each', () => {
    const c = '{{#if from}}yes {{from.title}}{{else}}no{{/if}}|{{#each items}}[{{name}}]{{/each}}';
    expect(renderTemplate(c, { from: { title: 'F' }, items: [{ name: 'a' }, { name: 'b' }] }, { templatePath: tpl }).output).toBe('yes F|[a][b]');
    expect(renderTemplate(c, { items: [] }, { templatePath: tpl }).output).toBe('no|');
  });

  it('registers only date, slug, upper, lower, join', () => {
    const c = '{{upper a}} {{lower b}} {{slug title}} {{join list ", "}} {{date d}}';
    const r = renderTemplate(c, { a: 'x', b: 'Y', title: 'Hello World!', list: ['1', '2'], d: '2026-09-09T10:00:00Z' }, { templatePath: tpl });
    expect(r.output).toBe('X y hello-world 1, 2 2026-09-09');
  });

  it('does not HTML-escape: & stays &', () => {
    const r = renderTemplate('{{title}} / {{{title}}}', { title: 'A & B <c>' }, { templatePath: tpl });
    expect(r.output).toBe('A & B <c> / A & B <c>');
  });

  it('renders unknown variables empty and reports them in missingVars', () => {
    const r = renderTemplate('[{{nope}}][{{from.title}}][{{#each xs}}{{y}}{{/each}}]', { xs: [{ z: 1 }] }, { templatePath: tpl });
    expect(r.output).toBe('[][][]');
    expect(r.missingVars).toEqual(['from.title', 'nope', 'xs[].y']);
  });
});

describe('renderTemplate: rejections name the template file and line', () => {
  it('rejects partials', () => {
    const e = fails('line1\nline2\n{{> partial}}');
    expect(e.exitCode).toBe(ExitCode.Validation);
    expect(e.message).toMatch(/^x\.md:3: partials are not allowed/);
  });

  it('rejects helpers outside the allow-list', () => {
    const e = fails('{{title}}\n{{lookup a b}}');
    expect(e.message).toMatch(/^x\.md:2: helper "lookup" is not allowed/);
  });

  it('rejects block helpers other than #if and #each', () => {
    const e = fails('a\n\n{{#with x}}{{y}}{{/with}}');
    expect(e.message).toMatch(/^x\.md:3: block helper "#with" is not allowed/);
    expect(fails('{{#unless x}}y{{/unless}}').message).toContain('#unless');
  });

  it('rejects sub-expressions and decorators', () => {
    expect(fails('{{upper (lower x)}}').message).toMatch(/^x\.md:1: sub-expressions are not allowed/);
    expect(fails('{{* inline "x"}}').message).toMatch(/^x\.md:1: /);
  });

  it('reports parse errors with file and line', () => {
    const e = fails('ok\n{{#if a}}\nnever closed');
    expect(e.message).toMatch(/^x\.md:\d+: /);
    expect(e.exitCode).toBe(ExitCode.Validation);
  });
});

describe('slugify', () => {
  it('lowercases, keeps [a-z0-9-], collapses dashes, caps at 60', () => {
    expect(slugify('Refund endpoint v2')).toBe('refund-endpoint-v2');
    expect(slugify('  Hello --- World!! ')).toBe('hello-world');
    expect(slugify('x'.repeat(80))).toHaveLength(60);
    expect(slugify('Ünïcode café')).toBe('unicode-cafe');
    expect(slugify('!!!')).toBe('untitled');
  });
});
