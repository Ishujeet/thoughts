/**
 * Graph summary and staleness formatting for `thoughts status`
 * (specs/17 "Staleness", specs/04 "Codegraph"). Staleness is computed from
 * git only — it never triggers parsing at status time.
 */
import type { RepoGraph } from './graph.js';

export type GraphStaleness = 'fresh' | 'stale' | 'absent' | 'unknown';

export interface GraphStalenessInfo {
  staleness: GraphStaleness;
  /** Commits the code repo is ahead of the stored graph commit, when known. */
  ahead?: number;
}

/**
 * `fresh` — stored `codeCommit` equals repo HEAD · `stale` — HEAD has moved ·
 * `absent` — no graph · `unknown` — the graph exists but the repo is not
 * available on this machine, so git cannot compare.
 */
export function stalenessOf(graph: RepoGraph | undefined, head: string | undefined): GraphStalenessInfo {
  if (graph === undefined) return { staleness: 'absent' };
  if (head === undefined) return { staleness: 'unknown' };
  if (graph.codeCommit === head) return { staleness: 'fresh', ahead: 0 };
  return { staleness: 'stale' };
}

/** Human staleness word: `fresh`, `stale — n commits ahead`, `absent`, `unknown`. */
export function formatStaleness(info: GraphStalenessInfo): string {
  switch (info.staleness) {
    case 'fresh':
      return 'fresh';
    case 'stale':
      return info.ahead !== undefined ? `stale — ${info.ahead} commit${info.ahead === 1 ? '' : 's'} ahead` : 'stale';
    case 'absent':
      return 'absent';
    default:
      return 'unknown';
  }
}

/** The status line counts: `12 files · 40 symbols · 55 edges`. */
export function formatCounts(counts: { files: number; symbols: number; edges: number }): string {
  return `${counts.files} files · ${counts.symbols} symbols · ${counts.edges} edges`;
}
