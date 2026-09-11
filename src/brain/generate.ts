/**
 * Generated `index.md` and `log.md` (specs/09 "Generated index.md",
 * "Generated log.md"). `renderIndexes` and `appendLog` are pure; `regenerate`
 * writes only files whose content changed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { OKF_VERSION, type BrainConfig, type LintIssue, type LogEntry, type RegenerateResult, type Thought } from '../types.js';
import { validateThought } from './okf.js';
import { listThoughts } from './walk.js';

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function titleOf(t: Thought): string {
  const title = t.frontmatter.title;
  if (typeof title === 'string' && title.trim().length > 0) return title.trim();
  const base = t.location.path.slice(t.location.path.lastIndexOf('/') + 1);
  return base.replace(/\.md$/, '');
}

function descriptionOf(t: Thought): string {
  const d = t.frontmatter.description;
  return typeof d === 'string' ? d.trim().replace(/\s*\r?\n\s*/g, ' ') : '';
}

function statusOf(t: Thought): string | undefined {
  const s = t.frontmatter.status;
  return typeof s === 'string' && s.trim().length > 0 ? s.trim() : undefined;
}

/** `* [title](/path) - description `status`` */
export function renderEntry(t: Thought): string {
  let line = '* [' + titleOf(t) + '](' + t.location.path + ')';
  const description = descriptionOf(t);
  if (description.length > 0) line += ' - ' + description;
  const status = statusOf(t);
  if (status !== undefined && status !== 'stable') line += ' `' + status + '`';
  return line;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Date descending (undated last), then title ascending, then path — deterministic. */
export function compareThoughts(a: Thought, b: Thought): number {
  const da = a.location.date ?? '';
  const db = b.location.date ?? '';
  if (da !== db) {
    if (da === '') return 1;
    if (db === '') return -1;
    return cmp(db, da);
  }
  const t = cmp(titleOf(a), titleOf(b));
  if (t !== 0) return t;
  return cmp(a.location.path, b.location.path);
}

function capitalise(kind: string): string {
  return kind.length === 0 ? kind : kind[0]!.toUpperCase() + kind.slice(1);
}

function count(n: number): string {
  return n + (n === 1 ? ' thought' : ' thoughts');
}

/** `# heading` plus one `## Kind` section per kind, in `brain.kinds` order then alphabetical. */
function renderZoneIndex(heading: string, thoughts: Thought[], brain: BrainConfig): string {
  const byKind = new Map<string, Thought[]>();
  for (const t of thoughts) {
    const kind = t.location.kind;
    if (kind === undefined) continue;
    let list = byKind.get(kind);
    if (!list) {
      list = [];
      byKind.set(kind, list);
    }
    list.push(t);
  }
  const declared = Object.keys(brain.kinds);
  const extra = [...byKind.keys()].filter((k) => !declared.includes(k)).sort();
  const order = [...declared, ...extra];

  const parts: string[] = ['# ' + heading];
  for (const kind of order) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    list.sort(compareThoughts);
    parts.push('## ' + capitalise(kind) + '\n' + list.map(renderEntry).join('\n'));
  }
  return parts.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/**
 * Render every generated index. Keys are bundle-relative paths with a leading
 * slash. Pure and deterministic: identical input yields identical bytes.
 */
export function renderIndexes(thoughts: Thought[], brain: BrainConfig): Record<string, string> {
  const shared: Thought[] = [];
  const repos = new Map<string, Thought[]>();
  const users = new Map<string, Thought[]>();
  for (const entry of brain.repos) repos.set(entry.id, []);

  for (const t of thoughts) {
    const loc = t.location;
    if (loc.zone === 'shared') {
      shared.push(t);
    } else if (loc.zone === 'repos') {
      const id = loc.owner ?? '';
      const list = repos.get(id);
      if (list) list.push(t);
      else repos.set(id, [t]);
    } else {
      const id = loc.owner ?? '';
      const list = users.get(id);
      if (list) list.push(t);
      else users.set(id, [t]);
    }
  }

  const files: Record<string, string> = {};
  files['/shared/index.md'] = renderZoneIndex('shared', shared, brain);
  const repoIds = [...repos.keys()].sort();
  for (const id of repoIds) files['/repos/' + id + '/index.md'] = renderZoneIndex(id, repos.get(id) ?? [], brain);
  const userIds = [...users.keys()].sort();
  for (const id of userIds) files['/users/' + id + '/index.md'] = renderZoneIndex('user:' + id, users.get(id) ?? [], brain);

  // Root index
  let repoTotal = 0;
  for (const list of repos.values()) repoTotal += list.length;
  let userTotal = 0;
  for (const list of users.values()) userTotal += list.length;

  const sections: string[] = [];
  sections.push('# ' + brain.name);
  sections.push(
    '## Zones\n' +
      [
        '* [shared](/shared/index.md) - ' + count(shared.length),
        '* repos - ' + count(repoTotal) + ' across ' + repoIds.length + (repoIds.length === 1 ? ' repo' : ' repos'),
        '* users - ' + count(userTotal) + ' across ' + userIds.length + (userIds.length === 1 ? ' user' : ' users'),
      ].join('\n'),
  );
  if (repoIds.length > 0) {
    sections.push(
      '## Repos\n' + repoIds.map((id) => '* [' + id + '](/repos/' + id + '/index.md) - ' + count(repos.get(id)?.length ?? 0)).join('\n'),
    );
  }
  if (userIds.length > 0) {
    sections.push(
      '## Users\n' +
        userIds.map((id) => '* [user:' + id + '](/users/' + id + '/index.md) - ' + count(users.get(id)?.length ?? 0)).join('\n'),
    );
  }
  if (thoughts.length > 0) {
    const recent = [...thoughts].sort(compareThoughts).slice(0, 20);
    sections.push('## Recently updated\n' + recent.map(renderEntry).join('\n'));
  }
  files['/index.md'] = '---\nokf_version: "' + OKF_VERSION + '"\n---\n' + sections.join('\n\n') + '\n';

  return files;
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

const DATE_HEADING = /^## (\d{4}-\d{2}-\d{2})\s*$/;

export function renderLogLine(entry: LogEntry): string {
  const link = '[' + entry.title + '](' + entry.path + ')';
  switch (entry.change) {
    case 'added':
      return '* **Added**: ' + link + (entry.by ? ' by ' + entry.by : '');
    case 'updated':
      return '* **Updated**: ' + link + (entry.note ? ' — ' + entry.note : '');
    case 'removed':
      return '* **Removed**: ' + link + (entry.note ? ' — ' + entry.note : '');
  }
}

interface LogSection {
  date: string;
  lines: string[];
}

function trimBlank(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] as string).trim() === '') out.pop();
  while (out.length > 0 && (out[0] as string).trim() === '') out.shift();
  return out;
}

function parseLog(existing: string): { header: string[]; sections: LogSection[] } {
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const header: string[] = [];
  const sections: LogSection[] = [];
  let current: LogSection | undefined;
  for (const line of lines) {
    const m = DATE_HEADING.exec(line);
    if (m) {
      current = { date: m[1] as string, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      header.push(line);
    }
  }
  return { header: trimBlank(header), sections: sections.map((s) => ({ date: s.date, lines: trimBlank(s.lines) })) };
}

/**
 * Add entries for `date` to a `log.md`. Newest date first; an existing section
 * for `date` receives the new lines at its top with exact duplicates dropped;
 * every other section is left as it was. Empty `entries` returns `existing`.
 */
export function appendLog(existing: string, date: string, entries: LogEntry[]): string {
  if (entries.length === 0) return existing;
  const { header, sections } = parseLog(existing);
  if (header.length === 0) header.push('# Log');

  const newLines: string[] = [];
  for (const entry of entries) {
    const line = renderLogLine(entry);
    if (!newLines.includes(line)) newLines.push(line);
  }

  const idx = sections.findIndex((s) => s.date === date);
  if (idx >= 0) {
    const section = sections[idx] as LogSection;
    const fresh = newLines.filter((l) => !section.lines.includes(l));
    section.lines = [...fresh, ...section.lines];
  } else {
    // insert keeping newest-first order; equal dates cannot happen here
    let pos = sections.findIndex((s) => s.date < date);
    if (pos < 0) pos = sections.length;
    sections.splice(pos, 0, { date, lines: newLines });
  }

  const blocks = [header.join('\n'), ...sections.map((s) => ['## ' + s.date, ...s.lines].join('\n'))];
  return blocks.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Regenerate
// ---------------------------------------------------------------------------

export interface RegenerateOptions {
  log?: { date: string; entries: LogEntry[] };
  dryRun?: boolean;
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function regenerate(brainRoot: string, brain: BrainConfig, opts: RegenerateOptions = {}): Promise<RegenerateResult> {
  const thoughts = await listThoughts(brainRoot);
  const files = renderIndexes(thoughts, brain);
  if (opts.log) {
    const current = (await readIfExists(path.join(brainRoot, 'log.md'))) ?? '# Log\n\n';
    files['/log.md'] = appendLog(current, opts.log.date, opts.log.entries);
  }

  const changed: string[] = [];
  for (const rel of Object.keys(files).sort()) {
    const abs = path.join(brainRoot, rel.slice(1));
    const content = files[rel] as string;
    const current = await readIfExists(abs);
    if (current === content) continue;
    changed.push(rel);
    if (!opts.dryRun) {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, 'utf8');
    }
  }

  const issues: LintIssue[] = [];
  for (const t of thoughts) issues.push(...validateThought(t));
  return { files, changed, thoughts, issues };
}
