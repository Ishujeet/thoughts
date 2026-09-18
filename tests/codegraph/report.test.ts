/**
 * The report lines and rows the codegraph step produces (specs/03 step 7,
 * specs/02 step 8, specs/04 "Codegraph"): pure formatting.
 */
import { describe, expect, it } from 'vitest';
import { describeOutcome, stepReportFor, type CodegraphOutcome } from '../../src/commands/codegraph-step.js';
import { formatCounts, formatStaleness, stalenessOf, type GraphStalenessInfo } from '../../src/codegraph/graph-status.js';
import { renderGraphIndex } from '../../src/codegraph/render.js';
import type { RepoGraph } from '../../src/codegraph/graph.js';

const outcome = (partial: Partial<CodegraphOutcome>): CodegraphOutcome => ({ status: 'updated', changedFiles: 0, ...partial });

describe('describeOutcome', () => {
  it('reports a full rebuild with the specs/17 wording, one line', () => {
    expect(describeOutcome(outcome({ status: 'rebuilt', changedFiles: 501 }))).toBe('codegraph: rebuilt (501 files)');
    expect(describeOutcome(outcome({ changedFiles: 1 }))).toBe('codegraph: 1 file changed');
    expect(describeOutcome(outcome({ changedFiles: 3 }))).toBe('codegraph: 3 files changed');
    expect(describeOutcome(outcome({ status: 'unchanged' }))).toBeUndefined();
    expect(describeOutcome(outcome({ status: 'skipped', reason: 'no grammars' }))).toBeUndefined();
    expect(describeOutcome(undefined)).toBeUndefined();
  });
});

describe('stepReportFor', () => {
  it('gives init a row with the counts, or skipped with the cause', () => {
    expect(stepReportFor('payments-api', outcome({ status: 'rebuilt', files: 12, symbols: 40, edges: 55 }))).toEqual({
      step: 'codegraph payments-api',
      state: 'done',
      detail: '12 files · 40 symbols · 55 edges',
    });
    expect(stepReportFor('payments-api', outcome({ status: 'unchanged' }))).toEqual({ step: 'codegraph payments-api', state: 'up-to-date' });
    expect(stepReportFor('payments-api', outcome({ status: 'skipped', reason: 'no commits' }))).toEqual({
      step: 'codegraph payments-api',
      state: 'skipped',
      detail: 'no commits',
    });
  });
});

describe('staleness formatting', () => {
  it('says fresh, stale — n commits ahead, absent, unknown', () => {
    const graph = { codeCommit: 'c1' } as RepoGraph;
    expect(stalenessOf(undefined, 'c1')).toEqual({ staleness: 'absent' });
    expect(stalenessOf(graph, 'c1')).toEqual({ staleness: 'fresh', ahead: 0 });
    expect(stalenessOf(graph, 'c2')).toEqual({ staleness: 'stale' });
    expect(stalenessOf(graph, undefined)).toEqual({ staleness: 'unknown' });
    const info = (partial: Partial<GraphStalenessInfo>): GraphStalenessInfo => ({ staleness: 'fresh', ...partial });
    expect(formatStaleness(info({ staleness: 'fresh', ahead: 0 }))).toBe('fresh');
    expect(formatStaleness(info({ staleness: 'stale', ahead: 1 }))).toBe('stale — 1 commit ahead');
    expect(formatStaleness(info({ staleness: 'stale', ahead: 3 }))).toBe('stale — 3 commits ahead');
    expect(formatStaleness(info({ staleness: 'absent' }))).toBe('absent');
  });
});

describe('formatCounts', () => {
  it('renders the specs/04 counts line', () => {
    expect(formatCounts({ files: 12, symbols: 40, edges: 55 })).toBe('12 files · 40 symbols · 55 edges');
  });
});

describe('renderGraphIndex', () => {
  it('renders modules, symbols per file and cross-repo deps deterministically', () => {
    const graph: RepoGraph = {
      version: 1,
      repoId: 'orders-service',
      codeCommit: 'a'.repeat(40),
      counts: { files: 1, symbols: 1, edges: 2 },
      nodes: [
        { id: 'f1', kind: 'file', name: 'src/index.ts', path: 'src/index.ts', language: 'ts', codeCommit: 'a'.repeat(40) },
        { id: 'm1', kind: 'module', name: '@acme/orders-service', manifest: 'brain.yml', codeCommit: 'a'.repeat(40) },
        { id: 'm2', kind: 'module', name: '@acme/payments-api', codeCommit: 'a'.repeat(40) },
        { id: 's1', kind: 'symbol', name: 'place', path: 'src/index.ts', symbolKind: 'function', line: 2, endLine: 4, codeCommit: 'a'.repeat(40) },
      ],
      edges: [],
    };
    const first = renderGraphIndex(graph, [{ repo: 'payments-api', module: '@acme/payments-api' }]);
    expect(first).toBe(renderGraphIndex(graph, [{ repo: 'payments-api', module: '@acme/payments-api' }]));
    expect(first).toContain('# codegraph — orders-service');
    expect(first).toContain('- @acme/orders-service (own package, from brain.yml)');
    expect(first).toContain('- @acme/payments-api');
    expect(first).toContain('- function place (2–4)');
    expect(first).toContain('- imports `@acme/payments-api` from payments-api');
  });
});
