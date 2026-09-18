/**
 * `thoughts sync` (specs/03). Pipeline order is fixed by the contract:
 * scan → validate → regenerate → commit → pull --rebase → push → report.
 * Store steps run through the brain backend (specs/16); log building and the
 * commit message stay backend-agnostic here.
 */
import type { Command } from 'commander';
import path from 'node:path';
import { cliVersion } from '../assets.js';
import { loadBrainConfig } from '../brain/config.js';
import { resolveBackend } from '../brain/backends/resolve.js';
import { conflictError, type BrainBackend, type WorkspaceChange } from '../brain/backends/types.js';
import { regenerate } from '../brain/generate.js';
import { isCodegraphPath } from '../brain/location.js';
import { locate } from '../brain/layout.js';
import { formatIssues, hasErrors } from '../brain/lint.js';
import { parseFrontmatter, parseThought, validateThought } from '../brain/okf.js';
import { preflight } from '../brain/preflight.js';
import * as out from '../output.js';
import { loadAllowList } from '../security/allowlist.js';
import { hasBlocking, scanFiles } from '../security/scanner.js';
import { ExitCode, ThoughtsError, type BrainConfig, type LintIssue, type LogEntry } from '../types.js';
import { describeOutcome, runCodegraphStep, type CodegraphOutcome } from './codegraph-step.js';
import { SecretRefusedError, isoDate, printWarnings, translateGitError } from './common.js';

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
  /** Codegraph step outcome (specs/03 step 7); undefined when it was skipped. */
  codegraph?: CodegraphOutcome;
  /** Paths a store-wins conflict settled against this workspace (specs/16 nebula row). */
  storeWins?: string[];
}

interface ChangedFile {
  /** Bundle-relative path with leading slash. */
  bundlePath: string;
  code: string;
  deleted: boolean;
}

function changedFromBackend(entries: WorkspaceChange[]): ChangedFile[] {
  return entries
    // specs/17: generated codegraph data is neither scanned, validated, logged
    // nor reported — it is regenerated data, never hand-edited.
    .filter((e) => !isCodegraphPath('/' + e.path.replace(/^\/+/, '')))
    .map((e) => ({
      bundlePath: '/' + e.path.replace(/^\/+/, ''),
      code: e.code,
      deleted: e.deleted,
    }));
}

function titleOf(fm: { title?: unknown } | undefined, fallback: string): string {
  return typeof fm?.title === 'string' && fm.title.trim().length > 0 ? fm.title : path.posix.basename(fallback, '.md');
}

/** Build the log entries for the changed concept files. */
export async function buildLogEntries(backend: BrainBackend, changed: ChangedFile[]): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  for (const f of changed) {
    const loc = locate(f.bundlePath);
    if (!loc || !f.bundlePath.endsWith('.md') || f.bundlePath.includes('/references/')) continue;
    const rel = f.bundlePath.slice(1);
    if (f.deleted) {
      const old = await backend.read(rel, { revision: 'HEAD' });
      const fm = old !== undefined ? parseFrontmatter(old).frontmatter : undefined;
      entries.push({ change: 'removed', path: f.bundlePath, title: titleOf(fm, f.bundlePath) });
      continue;
    }
    const t = await parseThought(path.join(backend.workspace, rel), f.bundlePath);
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
    const old = await backend.read(rel, { revision: 'HEAD' });
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

/**
 * specs/16 sync table, nebula row: this backend settles a conflict itself by
 * taking the store's side — the workspace copy is overwritten and the loss is
 * recorded in `log.md` and in the store's change log (never silently). Returns
 * the settled paths, empty when `err` was not one of those conflicts.
 */
async function settleStoreWinsConflict(
  backend: BrainBackend,
  brain: BrainConfig,
  date: string,
  result: SyncResult,
  err: unknown,
): Promise<string[]> {
  if (!(err instanceof ThoughtsError) || err.exitCode !== ExitCode.Conflict) return [];
  const info = await backend.conflictInfo();
  if (info.storeWins !== true || info.conflicted.length === 0) return [];
  const settled = await backend.resolveConflicts({ brain, log: { date, entries: result.entries } });
  for (const p of settled) {
    out.warn(`store won for ${p}: the local change was overwritten and a note was added to log.md (specs/16)`);
  }
  if (settled.length > 0) result.storeWins = settled;
  return settled;
}

function groupOf(bundlePath: string): string {
  const loc = locate(bundlePath);
  if (!loc) return 'other';
  if (loc.zone === 'shared') return 'shared';
  return `${loc.zone}/${loc.owner ?? ''}`;
}

async function collectIncoming(backend: BrainBackend, from: string, to: string): Promise<IncomingChange[]> {  if (from === to) return [];
  const diff = await backend.diff(from, to);
  const incoming: IncomingChange[] = [];
  for (const d of diff) {
    const bundlePath = '/' + d.path;
    const loc = locate(bundlePath);
    if (!loc || !bundlePath.endsWith('.md') || bundlePath.includes('/references/')) continue;
    const change: IncomingChange['change'] = d.code[0] === 'D' ? 'removed' : d.code[0] === 'A' ? 'added' : 'updated';
    let title = path.posix.basename(bundlePath, '.md');
    if (change !== 'removed') {
      try {
        const t = await parseThought(path.join(backend.workspace, d.path), bundlePath);
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

function printIncoming(incoming: IncomingChange[], say: (m: string) => void): void {
  if (incoming.length === 0) return;
  say('incoming from other repos:');
  let current = '';
  for (const c of incoming) {
    if (c.group !== current) {
      current = c.group;
      say(`  ${current}`);
    }
    say(`    ${c.change.padEnd(7)} ${(c.kind ?? '').padEnd(10)} ${c.title}`);
  }
}

export async function runSync(opts: SyncOptions, cwd: string): Promise<SyncResult> {
  if (opts.watch !== undefined && opts.watch !== false) {
    // TODO(milestone 2): --watch [interval] loop with back-off (specs/03 "Watch mode").
    throw new ThoughtsError('--watch is not implemented in milestone 1', ExitCode.Validation);
  }
  if (opts.pullOnly && opts.pushOnly) {
    throw new ThoughtsError('--pull-only and --push-only are mutually exclusive', ExitCode.Validation);
  }
  // `--quiet` is process-global in output.ts; restore it afterwards so a
  // caller (init's initial sync) keeps its own stdout.
  const wasQuiet = out.isQuiet();
  if (opts.quiet) out.setQuiet(true);
  try {
    return await syncImpl(opts, cwd);
  } finally {
    if (opts.quiet) out.setQuiet(wasQuiet);
  }
}

async function syncImpl(opts: SyncOptions, cwd: string): Promise<SyncResult> {
  // With --json stdout is exactly one JSON document (contract §7): the
  // progress lines go to stderr as debug output; the report carries the facts.
  const say = (m: string): void => (opts.json ? out.debug(m) : out.info(m));
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
  const backend = await resolveBackend({
    brainId: ctx.brainId ?? path.basename(brainRoot),
    workspace: brainRoot,
    brain,
    brainRef: ctx.repoConfig?.brain ?? opts.brain,
  });

  // TODO(milestone 2): brain.yml hooks.pre_sync / hooks.post_sync (specs/03 "Hooks").

  // An earlier run left a conflicted rebase behind?
  if ((await backend.conflictInfo()).inProgress) {
    const remaining = await backend.resolveConflicts({ brain, log: { date, entries: [] } });
    if (remaining.length > 0) throw conflictError(remaining);
  }

  const remote = await backend.remoteUrl();
  const upstreamBefore = await backend.upstreamRevision();
  let headBefore: string | undefined = await backend.revision();

  let pushPaths: string[] = [];
  if (!opts.pullOnly) {
    const changed = changedFromBackend(await backend.dirty());
    pushPaths = changed.map((c) => c.bundlePath);

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
    const entries = await buildLogEntries(backend, changed);
    result.entries = entries;
    await regenerate(brainRoot, brain, { log: { date, entries } });

    // 3. Commit to the workspace (the store sees it in step 5).
    if ((await backend.dirty()).length > 0) {
      const message = commitMessage(repoId, entries, opts.message);
      try {
        const committed = await backend.commit(message);
        if (committed !== undefined) {
          result.committed = committed;
          result.commitMessage = message;
          headBefore = committed;
          say(`committed ${committed.slice(0, 7)}: ${message.split('\n')[0]}`);
        }
      } catch (err) {
        // A store-wins backend (specs/16 nebula row) settles its own conflict:
        // the store keeps its version, the loss is recorded, sync continues.
        if ((await settleStoreWinsConflict(backend, brain, date, result, err)).length === 0) {
          throw translateGitError(err, 'other');
        }
      }
    }
  }

  // 4. Pull.
  if (!opts.pushOnly && remote !== undefined) {
    try {
      await backend.pull(undefined, { brain, log: { date, entries: result.entries } });
      result.pulled = true;
    } catch (err) {
      // A conflict the backend could not settle arrives as exit 4 (specs/16);
      // a store-wins backend (specs/16 nebula row) settles its own and syncs on.
      if ((await settleStoreWinsConflict(backend, brain, date, result, err)).length === 0) {
        if (err instanceof ThoughtsError && err.exitCode === ExitCode.Conflict) throw err;
        throw translateGitError(err, 'pull', remote);
      }
      result.pulled = true;
    }
  }

  // The rebase rewrites the local commit's sha, and drops it entirely when it
  // only regenerated indexes that upstream already carried. Re-find it by its
  // message among the commits now sitting on top of the old upstream.
  if (result.committed && result.commitMessage && result.pulled && upstreamBefore !== undefined) {
    let found: string | undefined;
    for (const sha of await backend.revisionsSince(upstreamBefore)) {
      if ((await backend.messageOf(sha)) === result.commitMessage) {
        found = sha;
        break;
      }
    }
    if (found === undefined) {
      out.debug(`local commit ${result.committed.slice(0, 7)} became empty during the rebase and was dropped`);
      delete result.committed;
      delete result.commitMessage;
    } else {
      result.committed = found;
    }
  }

  // 5. Push.
  const wantPush = opts.push !== false && !opts.pullOnly && remote !== undefined;
  if (wantPush) {
    try {
      const pushed = await backend.push({ paths: pushPaths, message: result.commitMessage ?? '', logEntries: result.entries });
      result.pushed = pushed.pushed;
    } catch (err) {
      throw translateGitError(err, 'push', remote);
    }
  }

  // 6. Reindex: TODO(milestone 2): SQLite FTS incremental reindex (specs/03 step 6, specs/05).

  // 7. Codegraph (specs/03 step 7, specs/17): incremental against the code
  // repo's HEAD. Never fatal: any failure skips this repo's step with exactly
  // one warning and the stored graph stays as it is.
  const codeRepoRoot = ctx.mode === 'repo' ? ctx.repoRoot : undefined;
  // The pull may have brought a new brain.yml (a sibling's `package:` field):
  // the step reads the brain as the store now has it (specs/17 "Cross-repo
  // edges" are recomputed at brain level).
  const brainNow = (result.pulled ? await loadBrainConfig(brainRoot) : brain) ?? brain;
  const codegraph = await runCodegraphStep(backend, brainNow, codeRepoRoot, repoId, { now, push: result.pushed });
  if (codegraph.status !== 'skipped') result.codegraph = codegraph;
  const graphLine = describeOutcome(codegraph);
  if (graphLine !== undefined) say(graphLine);

  // 8. Report.
  const headNow = await backend.revision();
  if (headBefore !== undefined && headNow !== undefined) {
    result.incoming = await collectIncoming(backend, headBefore, headNow);
  }
  printIncoming(result.incoming, say);
  if (!result.committed && result.incoming.length === 0) say('nothing to do');
  else if (result.pushed) say('pushed');
  if (opts.json) out.print(JSON.stringify(result, null, 2));
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
