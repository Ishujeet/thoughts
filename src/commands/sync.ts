/**
 * `thoughts sync` (specs/03). Pipeline order is fixed by the contract:
 * scan → validate → regenerate → commit → pull --rebase → push → report.
 */
import type { Command } from 'commander';
import path from 'node:path';
import { cliVersion } from '../assets.js';
import { loadBrainConfig } from '../brain/config.js';
import { regenerate } from '../brain/generate.js';
import { locate } from '../brain/layout.js';
import { formatIssues, hasErrors } from '../brain/lint.js';
import { parseFrontmatter, parseThought, validateThought } from '../brain/okf.js';
import { preflight } from '../brain/preflight.js';
import * as git from '../git.js';
import * as out from '../output.js';
import { loadAllowList } from '../security/allowlist.js';
import { hasBlocking, scanFiles } from '../security/scanner.js';
import { ExitCode, ThoughtsError, type BrainConfig, type LintIssue, type LogEntry } from '../types.js';
import { SecretRefusedError, isGeneratedFile, isoDate, printWarnings, translateGitError } from './common.js';

export interface SyncOptions {
  pullOnly?: boolean;
  pushOnly?: boolean;
  message?: string;
  /** commander's `--no-push` sets `push: false`. */
  push?: boolean;
  quiet?: boolean;
  allowInvalid?: boolean;
  watch?: string | boolean;
  brain?: string;
  json?: boolean;
  now?: Date;
}

export interface IncomingChange {
  /** `repos/<id>`, `shared`, or `users/<id>`. */
  group: string;
  change: 'added' | 'updated' | 'removed';
  path: string;
  kind?: string;
  title: string;
}

export interface SyncResult {
  brainRoot: string;
  repoId: string;
  /** Sha of the local commit made by this run, if any. */
  committed?: string;
  commitMessage?: string;
  entries: LogEntry[];
  pulled: boolean;
  pushed: boolean;
  incoming: IncomingChange[];
  /** Lint issues found in changed files (warnings when the run continued). */
  issues: LintIssue[];
}

interface ChangedFile {
  /** Bundle-relative path with leading slash. */
  bundlePath: string;
  code: string;
  deleted: boolean;
}

function changedFromStatus(entries: git.StatusEntry[]): ChangedFile[] {
  return entries
    .filter((e) => !e.path.startsWith('.git/'))
    .map((e) => ({
      bundlePath: '/' + e.path.replace(/^\/+/, ''),
      code: e.code,
      deleted: e.code[0] === 'D' || e.code[1] === 'D',
    }));
}

function titleOf(fm: { title?: unknown } | undefined, fallback: string): string {
  return typeof fm?.title === 'string' && fm.title.trim().length > 0 ? fm.title : path.posix.basename(fallback, '.md');
}

/** Build the log entries for the changed concept files. */
export async function buildLogEntries(brainRoot: string, changed: ChangedFile[]): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (const f of changed) {
    const loc = locate(f.bundlePath);
    if (!loc || !f.bundlePath.endsWith('.md') || f.bundlePath.includes('/references/')) continue;
    if (f.deleted) {
      const old = await git.showAtHead(brainRoot, f.bundlePath);
      const fm = old !== undefined ? parseFrontmatter(old).frontmatter : undefined;
      entries.push({ change: 'removed', path: f.bundlePath, title: titleOf(fm, f.bundlePath) });
      continue;
    }
    const t = await parseThought(path.join(brainRoot, f.bundlePath.slice(1)), f.bundlePath);
    const title = titleOf(t.frontmatter, f.bundlePath);
    const isNew = f.code === '??' || f.code[0] === 'A' || f.code[1] === 'A' || f.code[0] === 'R' || f.code[0] === 'C';
    if (isNew) {
      const entry: LogEntry = { change: 'added', path: f.bundlePath, title };
      const by = t.frontmatter.generated?.by;
      if (typeof by === 'string' && by.length > 0) entry.by = by;
      entries.push(entry);
      continue;
    }
    const entry: LogEntry = { change: 'updated', path: f.bundlePath, title };
    const old = await git.showAtHead(brainRoot, f.bundlePath);
    if (old !== undefined) {
      const oldStatus = parseFrontmatter(old).frontmatter.status;
      const newStatus = t.frontmatter.status;
      if (oldStatus !== newStatus && (oldStatus !== undefined || newStatus !== undefined)) {
        entry.note = `status ${String(oldStatus ?? 'none')} → ${String(newStatus ?? 'none')}`;
      }
    }
    entries.push(entry);
  }
  return entries;
}

/** Commit message in the specs/03 format. `firstLine` overrides only the first line. */
export function commitMessage(repoId: string, entries: LogEntry[], firstLine?: string): string {
  const added = entries.filter((e) => e.change === 'added');
  const updated = entries.filter((e) => e.change === 'updated');
  const removed = entries.filter((e) => e.change === 'removed');
  const head = firstLine ?? `thoughts(${repoId}): ${added.length} added, ${updated.length} updated`;
  const lines: string[] = [];
  for (const e of added) lines.push(`- added   ${e.path.slice(1)}`);
  for (const e of updated) lines.push(`- updated ${e.path.slice(1)}`);
  for (const e of removed) lines.push(`- removed ${e.path.slice(1)}`);
  return lines.length > 0 ? `${head}\n\n${lines.join('\n')}` : head;
}

function groupOf(bundlePath: string): string {
  const loc = locate(bundlePath);
  if (!loc) return 'other';
  if (loc.zone === 'shared') return 'shared';
  return `${loc.zone}/${loc.owner ?? ''}`;
}

async function collectIncoming(brainRoot: string, from: string, to: string): Promise<IncomingChange[]> {
  if (from === to) return [];
  const diff = await git.diffNameStatus(brainRoot, from, to);
  const incoming: IncomingChange[] = [];
  for (const d of diff) {
    const bundlePath = '/' + d.path;
    const loc = locate(bundlePath);
    if (!loc || !bundlePath.endsWith('.md') || bundlePath.includes('/references/')) continue;
    const change: IncomingChange['change'] = d.code[0] === 'D' ? 'removed' : d.code[0] === 'A' ? 'added' : 'updated';
    let title = path.posix.basename(bundlePath, '.md');
    if (change !== 'removed') {
      try {
        const t = await parseThought(path.join(brainRoot, d.path), bundlePath);
        title = titleOf(t.frontmatter, bundlePath);
      } catch {
        // unreadable; keep the filename
      }
    }
    const item: IncomingChange = { group: groupOf(bundlePath), change, path: bundlePath, title };
    if (loc.kind) item.kind = loc.kind;
    incoming.push(item);
  }
  incoming.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path));
  return incoming;
}

function printIncoming(incoming: IncomingChange[]): void {
  if (incoming.length === 0) return;
  out.info('incoming from other repos:');
  let current = '';
  for (const c of incoming) {
    if (c.group !== current) {
      current = c.group;
      out.info(`  ${current}`);
    }
    out.info(`    ${c.change.padEnd(7)} ${(c.kind ?? '').padEnd(10)} ${c.title}`);
  }
}

/**
 * Resolve rebase conflicts that touch only generated files by taking the
 * upstream side and regenerating (re-appending this run's log entries).
 * Returns the conflicted concept files when a human must resolve them.
 */
async function resolveGeneratedConflicts(
  brainRoot: string,
  brain: BrainConfig,
  log: { date: string; entries: LogEntry[] },
): Promise<string[]> {
  for (let guard = 0; guard < 50; guard += 1) {
    const conflicted = await git.conflictedFiles(brainRoot);
    if (conflicted.length === 0) {
      if (!(await git.isRebaseInProgress(brainRoot))) return [];
      // Resolved but not continued (or an empty step): continue the rebase.
      try {
        await git.git(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: brainRoot });
      } catch {
        return conflicted;
      }
      continue;
    }
    const concept = conflicted.filter((p) => !isGeneratedFile('/' + p));
    if (concept.length > 0) return concept;
    // `ours` during a rebase is the upstream side; regenerate re-adds our entries.
    for (const p of conflicted) {
      try {
        await git.git(['checkout', '--ours', '--', p], { cwd: brainRoot });
      } catch {
        // deleted on one side: fall back to whatever is in the tree
      }
    }
    await regenerate(brainRoot, brain, { log });
    await git.addAll(brainRoot);
    try {
      await git.git(['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: brainRoot });
    } catch {
      // a further conflict in the next replayed commit; loop
    }
  }
  return await git.conflictedFiles(brainRoot);
}

function conflictError(files: string[]): ThoughtsError {
  return new ThoughtsError(`conflict in ${files.length} file${files.length === 1 ? '' : 's'}: ${files.join(', ')}`, ExitCode.Conflict, {
    hint: 'resolve with git, then run: thoughts sync',
  });
}

export async function runSync(opts: SyncOptions, cwd: string): Promise<SyncResult> {
  if (opts.watch !== undefined && opts.watch !== false) {
    // TODO(milestone 2): --watch [interval] loop with back-off (specs/03 "Watch mode").
    throw new ThoughtsError('--watch is not implemented in milestone 1', ExitCode.Validation);
  }
  if (opts.pullOnly && opts.pushOnly) {
    throw new ThoughtsError('--pull-only and --push-only are mutually exclusive', ExitCode.Validation);
  }
  if (opts.quiet) out.setQuiet(true);
  const now = opts.now ?? new Date();
  const ctx = await preflight(cwd, { command: 'sync', brain: opts.brain, cliVersion: cliVersion() });
  printWarnings(ctx);
  if (!ctx.brainRoot) {
    throw new ThoughtsError('no brain found', ExitCode.Validation, {
      hint: 'run inside an initialised repo or a brain clone, or pass --brain <id>',
    });
  }
  const brainRoot = ctx.brainRoot;
  const brain = ctx.brainConfig ?? (await loadBrainConfig(brainRoot));
  const repoId = ctx.mode === 'repo' && ctx.repoConfig ? ctx.repoConfig.repo_id : 'brain';
  const date = isoDate(now);
  const result: SyncResult = { brainRoot, repoId, entries: [], pulled: false, pushed: false, incoming: [], issues: [] };

  // TODO(milestone 2): brain.yml hooks.pre_sync / hooks.post_sync (specs/03 "Hooks").

  // An earlier run left a conflicted rebase behind?
  if (await git.isRebaseInProgress(brainRoot)) {
    const remaining = await resolveGeneratedConflicts(brainRoot, brain, { date, entries: [] });
    if (remaining.length > 0) throw conflictError(remaining);
  }

  const remote = await git.remoteUrl(brainRoot);
  let headBefore: string | undefined = (await git.hasHead(brainRoot)) ? await git.headSha(brainRoot) : undefined;

  if (!opts.pullOnly) {
    const status = await git.statusPorcelain(brainRoot);
    const changed = changedFromStatus(status);

    // 0. Scan for secrets — before anything is staged.
    const toScan = changed.filter((c) => !c.deleted).map((c) => c.bundlePath);
    if (toScan.length > 0) {
      const scanOpts: Parameters<typeof scanFiles>[2] = { allow: await loadAllowList(brainRoot) };
      if (brain.security?.patterns) scanOpts.customPatterns = brain.security.patterns;
      if (brain.security?.entropy !== undefined) scanOpts.entropy = brain.security.entropy;
      const findings = await scanFiles(brainRoot, toScan, scanOpts);
      if (hasBlocking(findings)) throw new SecretRefusedError(findings, 'commit');
      for (const f of findings) out.warn(`${f.path}:${f.line}: possible secret (${f.kind}) ${f.masked}`);
    }

    // 1. Validate changed concept files.
    const knownTypes = Object.values(brain.kinds)
      .map((k) => (typeof k['type'] === 'string' ? (k['type'] as string) : undefined))
      .filter((t): t is string => t !== undefined);
    const issues: LintIssue[] = [];
    for (const c of changed) {
      if (c.deleted || !c.bundlePath.endsWith('.md') || c.bundlePath.includes('/references/')) continue;
      const loc = locate(c.bundlePath);
      if (!loc) continue;
      const t = await parseThought(path.join(brainRoot, c.bundlePath.slice(1)), c.bundlePath);
      issues.push(...validateThought(t, { knownTypes }));
    }
    result.issues = issues;
    const errors = issues.filter((i) => i.severity === 'error');
    const warnings = issues.filter((i) => i.severity === 'warning');
    if (warnings.length > 0) out.warn(formatIssues(warnings));
    if (hasErrors(issues) && !opts.allowInvalid) {
      out.error(formatIssues(errors));
      throw new ThoughtsError(`${errors.length} validation error${errors.length === 1 ? '' : 's'} in changed thoughts`, ExitCode.Validation, {
        hint: 'fix the files above, or re-run with --allow-invalid',
      });
    }

    // 2. Log entries + regenerate.
    const entries = await buildLogEntries(brainRoot, changed);
    result.entries = entries;
    await regenerate(brainRoot, brain, { log: { date, entries } });

    // 3. Commit.
    const after = await git.statusPorcelain(brainRoot);
    if (after.length > 0) {
      await git.addAll(brainRoot);
      const message = commitMessage(repoId, entries, opts.message);
      try {
        result.committed = await git.commit(brainRoot, message);
      } catch (err) {
        throw translateGitError(err, 'other');
      }
      result.commitMessage = message;
      headBefore = result.committed;
      out.info(`committed ${result.committed.slice(0, 7)}: ${message.split('\n')[0]}`);
    }
  }

  // 4. Pull.
  if (!opts.pushOnly && remote !== undefined) {
    try {
      await git.pullRebase(brainRoot);
      result.pulled = true;
    } catch (err) {
      const conflicted = await git.conflictedFiles(brainRoot);
      const rebasing = await git.isRebaseInProgress(brainRoot);
      if (conflicted.length > 0 || rebasing) {
        const remaining = await resolveGeneratedConflicts(brainRoot, brain, { date, entries: result.entries });
        if (remaining.length > 0) throw conflictError(remaining);
        result.pulled = true;
      } else {
        throw translateGitError(err, 'pull', remote);
      }
    }
  }

  // 5. Push.
  const wantPush = opts.push !== false && !opts.pullOnly && remote !== undefined;
  if (wantPush) {
    try {
      await git.push(brainRoot);
      result.pushed = true;
    } catch (err) {
      throw translateGitError(err, 'push', remote);
    }
  }

  // 6. Reindex: TODO(milestone 2): SQLite FTS incremental reindex (specs/03 step 6, specs/05).

  // 7. Report.
  if (headBefore !== undefined && (await git.hasHead(brainRoot))) {
    const headNow = await git.headSha(brainRoot);
    result.incoming = await collectIncoming(brainRoot, headBefore, headNow);
  }
  if (opts.json) {
    out.print(JSON.stringify(result, null, 2));
  } else {
    printIncoming(result.incoming);
    if (!result.committed && result.incoming.length === 0) out.info('nothing to do');
    else if (result.pushed) out.info('pushed');
  }
  return result;
}

export function register(program: Command): void {
  program
    .command('sync')
    .description('Pull new thoughts, regenerate indexes, commit and push local changes')
    .option('--pull-only', 'only pull and report; do not commit or push')
    .option('--push-only', 'commit and push without pulling first')
    .option('-m, --message <msg>', 'override the first line of the commit message')
    .option('--no-push', 'commit and pull but do not push')
    .option('--allow-invalid', 'commit even when changed thoughts fail OKF validation')
    .option('--watch [interval]', 'run on an interval (not implemented in milestone 1)')
    .option('--brain <id|url>', 'brain to use when outside a repo')
    .option('--json', 'print the result as JSON')
    .option('-q, --quiet', 'suppress informational output')
    .action(async (opts: SyncOptions) => {
      await runSync(opts, process.cwd());
    });
}
