/**
 * The generated human-readable summary (specs/17 "Generated index.md"):
 * module list, exported symbols per file, cross-repo dependency list.
 * Deterministic, like every generated file.
 */
import type { RepoGraph } from './graph.js';

export interface CrossRepoDep {
  /** The sibling repo whose package this repo imports. */
  repo: string;
  /** The package name matched. */
  module: string;
}

/**
 * Render `repos/<repo-id>/codegraph/index.md`. Pure: the same graph always
 * renders to the same bytes (no timestamp — that lives in the meta document).
 */
export function renderGraphIndex(graph: RepoGraph, deps: CrossRepoDep[] = []): string {
  const lines: string[] = [];
  const commit = graph.codeCommit.length > 12 ? graph.codeCommit.slice(0, 12) : graph.codeCommit;
  lines.push(`# codegraph — ${graph.repoId}`);
  lines.push('');
  lines.push(`Generated from commit \`${commit}\`. Do not edit (specs/17-codegraph.md).`);

  const modules = graph.nodes.filter((n) => n.kind === 'module');
  const files = graph.nodes.filter((n) => n.kind === 'file');
  const symbols = graph.nodes.filter((n) => n.kind === 'symbol');

  lines.push('');
  lines.push(`Modules: ${modules.length} · Files: ${files.length} · Symbols: ${symbols.length} · Edges: ${graph.counts.edges}`);
  if (modules.length > 0) {
    lines.push('');
    lines.push('## Modules');
    lines.push('');
    for (const m of modules) {
      const own = m.manifest !== undefined ? ` (own package, from ${m.manifest})` : '';
      lines.push(`- ${m.name}${own}`);
    }
  }

  lines.push('');
  lines.push('## Symbols per file');
  for (const file of files) {
    lines.push('');
    const lang = file.language !== undefined ? ` · ${file.language}` : '';
    lines.push(`### ${file.name}${lang}`);
    lines.push('');
    const own = symbols.filter((s) => s.path === file.name);
    if (own.length === 0) {
      lines.push('- (no symbols)');
      continue;
    }
    for (const s of own) {
      const range = s.line !== undefined && s.endLine !== undefined ? ` (${s.line}–${s.endLine})` : '';
      lines.push(`- ${s.symbolKind ?? 'symbol'} ${s.name}${range}`);
    }
  }

  if (deps.length > 0) {
    lines.push('');
    lines.push('## Cross-repo dependencies');
    lines.push('');
    for (const d of deps) lines.push(`- imports \`${d.module}\` from ${d.repo}`);
  }

  return lines.join('\n') + '\n';
}
