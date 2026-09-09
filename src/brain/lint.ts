/**
 * Lint rules over a whole brain (specs/09 "Validation rules", D19).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { BrainConfig, LintIssue, SourceRef, Thought } from '../types.js';
import { validateThought } from './okf.js';
import { listThoughts } from './walk.js';

function isBundlePath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

/** `okf/broken-link` warnings for `sources[].resource`, `supersedes`, `superseded_by`. */
async function brokenLinks(brainRoot: string, t: Thought): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const check = async (field: string, target: unknown): Promise<void> => {
    if (!isBundlePath(target)) return;
    const clean = target.split('#')[0] as string;
    if (await exists(path.join(brainRoot, clean.slice(1)))) return;
    issues.push({
      severity: 'warning',
      path: t.location.path,
      rule: 'okf/broken-link',
      message: field + ' points to ' + target + ' which does not exist in the bundle',
    });
  };
  const fm = t.frontmatter;
  if (Array.isArray(fm.sources)) {
    for (const [i, src] of fm.sources.entries()) {
      const resource = typeof src === 'object' && src !== null ? (src as SourceRef).resource : undefined;
      await check('sources[' + i + '].resource', resource);
    }
  }
  await check('supersedes', fm.supersedes);
  await check('superseded_by', fm.superseded_by);
  return issues;
}

/** `layout/repo-templates` errors: per-repo template overrides are not allowed (D19). */
async function repoTemplateDirs(brainRoot: string): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const reposDir = path.join(brainRoot, 'repos');
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(reposDir, { withFileTypes: true });
  } catch {
    return issues;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isDirectory()) continue;
    const templates = path.join(reposDir, entry.name, 'templates');
    let st: fs.Stats | undefined;
    try {
      st = await fs.promises.stat(templates);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      issues.push({
        severity: 'error',
        path: '/repos/' + entry.name + '/templates',
        rule: 'layout/repo-templates',
        message: 'per-repo template overrides are not allowed; templates change at brain level only',
      });
    }
  }
  return issues;
}

export async function lintBrain(brainRoot: string, brain: BrainConfig): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  const knownTypes = Object.values(brain.kinds).map((k) => k.template);
  const thoughts = await listThoughts(brainRoot);
  for (const t of thoughts) {
    issues.push(...validateThought(t, { knownTypes }));
    issues.push(...(await brokenLinks(brainRoot, t)));
  }
  issues.push(...(await repoTemplateDirs(brainRoot)));
  return issues;
}

/** `path:line: error|warning: message (rule)` per line; `:line` omitted when unknown. */
export function formatIssues(issues: LintIssue[]): string {
  return issues
    .map((i) => i.path + (i.line !== undefined ? ':' + i.line : '') + ': ' + i.severity + ': ' + i.message + ' (' + i.rule + ')')
    .join('\n');
}

export function hasErrors(issues: LintIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
