/**
 * Extraction against the committed fixtures (specs/17 "RepoGraph schema"):
 * symbols, imports, module candidates and intra-file call edges, per language.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractFile, shaOf } from '../../src/codegraph/extract.js';
import { languageForPath } from '../../src/codegraph/languages.js';

const FIXTURES = path.resolve(__dirname, 'fixtures');

/** Fixture sources are read as text: extraction is a pure function of source. */
function names(symbols: { name: string; kind: string }[]): string[] {
  return symbols.map((s) => `${s.kind} ${s.name}`);
}

describe('extractFile: ts', () => {
  it('extracts the exact top-level symbols and methods', async () => {
    const source = fixtureSource('ts/src/greet.ts');
    const e = await extractFile('src/greet.ts', 'ts', source);
    expect(names(e.symbols)).toEqual([
      'function greet',
      'class Widget',
      'method Widget.render',
      'type Shape',
      'type Alias',
      'const LIMIT',
      'function unused',
    ]);
    expect(e.symbols[0]).toMatchObject({ line: 6, endLine: 8 });
    expect(e.symbols[1]).toMatchObject({ line: 10, endLine: 14 });
    expect(e.symbols[2]).toMatchObject({ name: 'Widget.render', line: 11, endLine: 13 });
  });

  it('classifies imports and names external packages', async () => {
    const e = await extractFile('src/greet.ts', 'ts', fixtureSource('ts/src/greet.ts'));
    expect(e.imports).toEqual([
      { spec: './pad', kind: 'relative' },
      { spec: 'node:fs', kind: 'bare' },
      { spec: '@acme/payments-api', kind: 'bare' },
    ]);
    expect(e.modules).toEqual(['@acme/payments-api']);
  });

  it('resolves intra-file call edges only', async () => {
    const e = await extractFile('src/greet.ts', 'ts', fixtureSource('ts/src/greet.ts'));
    // render() calls greet() (same file); greet() calls pad() from another file.
    expect(e.calls).toEqual([{ caller: 'Widget.render', callee: 'greet' }]);
  });

  it('files without a v1 grammar still carry a sha but no symbols', async () => {
    expect(languageForPath('src/plain.md')).toBeUndefined();
    const source = fixtureSource('ts/src/plain.md');
    expect(languageForPath('src/plain.md')).toBeUndefined();
    expect(shaOf(source)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('extractFile: py', () => {
  it('extracts classes, methods, functions and module-level consts', async () => {
    const e = await extractFile('widget.py', 'py', fixtureSource('py/widget.py'));
    expect(names(e.symbols)).toEqual(['const LIMIT', 'class Widget', 'method Widget.render', 'function top']);
    expect(e.imports).toEqual([
      { spec: 'os', kind: 'bare' },
      { spec: 'payments_api', kind: 'bare' },
      { spec: '.helpers', kind: 'relative' },
    ]);
    expect(e.modules).toEqual(['os', 'payments_api']);
    // `load` is defined in another file: intra-file resolution makes no edge.
    expect(e.calls).toEqual([]);
  });

  it('resolves a call to a symbol of the same file', async () => {
    const src = ['def helper():', '    return 1', '', 'def top():', '    return helper()'].join('\n');
    const e = await extractFile('m.py', 'py', src);
    expect(e.calls).toEqual([{ caller: 'top', callee: 'helper' }]);
  });
});

describe('extractFile: js', () => {
  it('treats require() as an import', async () => {
    const e = await extractFile('app.js', 'js', ['const a = require("./a");', 'module.exports = a;'].join('\n'));
    expect(e.imports).toEqual([{ spec: './a', kind: 'relative' }]);
    expect(e.modules).toEqual([]);
    expect(names(e.symbols)).toEqual(['const a']);
  });
});

function fixtureSource(rel: string): string {
  return fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
}
