/**
 * `thoughts status` (specs/04): "what is in flight across the project?".
 *
 * The integration columns (ticket / PR state) wait for specs/10 —
 * `--no-integrations` is accepted and one warning says the state is
 * unavailable (specs/04 "Data sources").
 *
 * The Codegraph section (specs/04 "Codegraph", specs/17 "Status integration")
 * reads the stored graphs through the backend (`loadGraph`); staleness is
 * computed from git only. It is never fatal: any failure drops the section.
 *
 * Representation rule (specs/16): thought rows come from the brain backend
 * (`listThoughts` / `read` / `modifiedAt`), never from walking the workspace
 * here. The workspace mtime is only a fallback for files the store has not
 * seen yet (a brand-new, uncommitted thought).
 */
import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { cliVersion } from '../assets.js';
import { crossRepoEdges, deserialize, ownModuleName, type RepoGraph } from '../codegraph/graph.js';
import { formatCounts, stalenessOf, type GraphStaleness } from '../codegraph/graph-status.js';
import { resolveBackend } from '../brain/backends/resolve.js';
import { defaultUserId, loadBrainConfig } from '../brain/config.js';
import { locate } from '../brain/location.js';
import { parseFrontmatter } from '../brain/okf.js';
import { preflight } from '../brain/preflight.js';
import * as git from '../git.js';
import * as out from '../output.js';
import { ExitCode, ThoughtsError, type Frontmatter, type GlobalConfig, type SourceRef, type ThoughtLocation } from '../types.js';
import { assertRepoIdSegment, printWarnings, splitList } from './common.js';

export interface StatusOptions {
  repo?: string;
  /** commander's `--all`; the default behaviour is already "all, current repo first". */
  all?: boolean;
  /** Repeatable and/or comma-separated kind filter (`specs`, `plans`, ...). */
  kind?: string[];
  mine?: boolean;
  since?: string;
  json?: boolean;
  /** commander's `--no-integrations` sets `integrations: false`. */
  integrations?: boolean;
  /** commander's `--no-graph` sets `graph: false` and skips the Codegraph section. */
  graph?: boolean;
  brain?: string;
  now?: Date;
}

/** One displayed row (a thought in flight, or a stale one). Also the `--json` shape. */
export interface StatusRow {
  /** Bundle-relative path with leading slash. */
  path: string;
  /** Display group: `repos/<id>`, `shared`, or `users/<id>`. */
  group: string;
  /** Kind directory name (`specs`); empty when the file sits directly under the owner directory. */
  kind: string;
  title: string;
  /** Frontmatter status (`draft` / `stable` / `deprecated`); empty when absent. */
  status: string;
  /** Human age of the last brain modification, e.g. `2d`. */
  age: string;
  /** ISO 8601 modification time the age was computed from. */
  modifiedAt: string;
  /** True when the row sits in the stale bucket. */
  stale: boolean;
  /** Raw `stale_after` value; present on stale rows only. */
  staleAfter?: string;
}

export interface StatusGroup {
  /** `repos/<id>`, `shared`, or `users/<id>`. */
  group: string;
  /** True for the repo the command ran in. */
  current: boolean;
  rows: StatusRow[];
  /** Workspace-relative unsynced (uncommitted) brain paths under this group. */
  unsynced: string[];
}

export interface StatusResult {
  brainRoot: string;
  brainId: string;
  brainName: string;
  /** Repos declared in `brain.yml`. */
  repoCount: number;
  /** Repo id of the current code repo, when run inside one. */
  currentRepo?: string;
  /** Current code repo's live git state (specs/04 data sources, D17). */
  codeRepo?: { branch?: string; dirtyFiles: number };
  /** In-flight rows grouped by repo / zone; empty groups are dropped. */
  groups: StatusGroup[];
  /** Stale bucket: unresolved `stale_after` in the past, whatever the status. */
  stale: StatusRow[];
  /** Workspace-relative paths of local, uncommitted brain changes. */
  unsynced: string[];
  /** Age of the last brain sync, e.g. `synced 4m ago` (round-trips the human header). */
  synced?: string;
  /** Workspace-vs-store position, when the backend tracks revisions. */
  drift?: { ahead: number; behind: number };
  /** Codegraph section (specs/04): one entry per brain.yml repo. */
  graph: GraphRepoStatus[];
  warnings: string[];
}

/** One `--json graph` entry (specs/04 "Codegraph", specs/17 "Status integration"). */
export interface GraphRepoStatus {
  repo_id: string;
  files: number;
  symbols: number;
  edges: number;
  /** Commit the stored graph was extracted from, when a graph exists. */
  codeCommit?: string;
  /** Commits the repo's HEAD is ahead of the graph, when computable here. */
  code_ahead?: number;
  fresh: boolean;
  staleness: GraphStaleness;
  /** Sibling repos whose modules this repo imports (cross-repo deps). */
  deps: string[];
}

const DAY_MS = 86_400_000;
const DEFAULT_SINCE_MS = 14 * DAY_MS;
const DURATION_RE = /^(\d+)\s*([smhdw]?)$/;
const WEEK_MS = 7 * DAY_MS;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: DAY_MS, w: WEEK_MS };

/** `14d`, `2w`, `12h`, `30m`, `45s`, or a bare number of days, in milliseconds. */
export function parseDuration(value: string): number {
  const m = DURATION_RE.exec(value.trim());
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isFinite(n)) {
    throw new ThoughtsError(`invalid --since duration "${value}"`, ExitCode.Validation, {
      hint: 'use a duration like 14d, 2w, 12h, 30m or 45s',
    });
  }
  return n * UNIT_MS[m![2] || 'd']!;
}

/** Human age: `2d`, `5h`, `9m`, `12s`. */
export function formatAge(ms: number): string {
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms >= UNIT_MS.h!) return `${Math.floor(ms / UNIT_MS.h!)}h`;
  if (ms >= UNIT_MS.m!) return `${Math.floor(ms / UNIT_MS.m!)}m`;
  return `${Math.max(0, Math.floor(ms / UNIT_MS.s!))}s`;
}

function groupOf(loc: ThoughtLocation): string {
  if (loc.zone === 'shared') return 'shared';
  return `${loc.zone}/${loc.owner ?? ''}`;
}

async function mtimeOf(absPath: string): Promise<number> {
  try {
    return (await fs.promises.stat(absPath)).mtimeMs;
  } catch {
    return 0; // unreadable: treated as old; drafts and stale rows still show
  }
}

/** `stale_after` value when it is an unresolved date in the past, else undefined. */
function staleAfterInPast(fm: Frontmatter, now: Date): string | undefined {
  if (typeof fm.stale_after !== 'string' || fm.stale_after.trim().length === 0) return undefined;
  if (fm.status === 'deprecated') return undefined; // deprecated thoughts are settled, not stale
  const when = new Date(fm.stale_after);
  if (Number.isNaN(when.getTime()) || when.getTime() >= now.getTime()) return undefined;
  return fm.stale_after;
}

/** Repo ids a thought points at through `resource` / `sources[].resource` (specs/04 warnings). */
function collectResourceRepos(fm: Frontmatter, into: Map<string, string[]>, thoughtPath: string): void {
  const check = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const m = /^\/?repos\/([^/#?\s]+)\//.exec(value.trim());
    if (!m) return;
    const paths = into.get(m[1]!) ?? [];
    if (!paths.includes(thoughtPath)) paths.push(thoughtPath);
    into.set(m[1]!, paths);
  };
  check(fm.resource);
  if (Array.isArray(fm.sources)) {
    for (const src of fm.sources) check((src as SourceRef)?.resource);
  }
}

/** `--mine`: the thought is mine when it lives under `users/<me>/` or is authored by `human:<me>`. */
function isMine(loc: ThoughtLocation, fm: Frontmatter, userId: string): boolean {
  if (loc.zone === 'users') return loc.owner === userId;
  return fm.generated?.by === `human:${userId}`;
}

/** Order: current repo first, then brain.yml repos, then other repos, shared, users. */
function groupRank(group: string, brainRepoIds: string[], currentRepo: string | undefined): number {
  if (group.startsWith('repos/')) {
    const id = group.slice('repos/'.length);
    if (currentRepo !== undefined && id === currentRepo) return 0;
    const i = brainRepoIds.indexOf(id);
    if (i >= 0) return 1 + i / (brainRepoIds.length + 1);
    return 2;
  }
  if (group === 'shared') return 3;
  return 4;
}

/** specs/04: warn when more than N commits behind. N defaults to 20 and is set per brain in global config. */
function behindWarningThreshold(global: GlobalConfig | undefined, brainId: string): number {
  const value = global?.brains?.[brainId]?.behind_warning;
  return typeof value === 'number' && value >= 0 ? value : 20;
}

export async function runStatus(opts: StatusOptions, cwd: string): Promise<StatusResult> {
  const now = opts.now ?? new Date();
  const sinceMs = opts.since !== undefined ? parseDuration(opts.since) : DEFAULT_SINCE_MS;
  if (opts.repo !== undefined && opts.all) {
    throw new ThoughtsError('--repo and --all are mutually exclusive', ExitCode.Validation);
  }
  if (opts.repo !== undefined) assertRepoIdSegment(opts.repo, '--repo');
  const kinds = splitList(opts.kind);

  const ctx = await preflight(cwd, { command: 'status', brain: opts.brain, cliVersion: cliVersion() });
  printWarnings(ctx);
  if (!ctx.brainRoot) {
    throw new ThoughtsError('no brain found', ExitCode.Validation, {
      hint: 'run inside an initialised repo or a brain clone, or pass --brain <id>',
    });
  }
  const brainRoot = ctx.brainRoot;
  const brainId = ctx.brainId ?? path.basename(brainRoot);
  const brain = ctx.brainConfig ?? (await loadBrainConfig(brainRoot));
  const backend = await resolveBackend({
    brainId,
    workspace: brainRoot,
    brain,
    brainRef: ctx.repoConfig?.brain ?? opts.brain,
  });
  const currentRepo = ctx.mode === 'repo' && ctx.repoConfig ? ctx.repoConfig.repo_id : undefined;

  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
    out.warn(m);
  };

  // specs/04: integrations are unimplemented until specs/10 ships — one warning, never a failure.
  warn('integration state (tickets, PRs) is unavailable: specs/10-integrations.md is not implemented in this version');

  const mineUserId = opts.mine ? await defaultUserId(ctx.global) : undefined;

  // Brain rows — every thought through the backend, in-flight filter per specs/04.
  const rows: StatusRow[] = [];
  const staleRows: StatusRow[] = [];
  const resourceRepos = new Map<string, string[]>();
  for (const rel of await backend.listThoughts()) {
    const bundlePath = '/' + rel.replace(/^\/+/, '');
    const loc = locate(bundlePath);
    if (!loc || bundlePath.includes('/references/')) continue;
    const text = await backend.read(rel);
    if (text === undefined) continue;
    const fm = parseFrontmatter(text).frontmatter;
    collectResourceRepos(fm, resourceRepos, bundlePath);
    const status = typeof fm.status === 'string' ? fm.status : '';
    const staleAfter = staleAfterInPast(fm, now);
    // Store metadata first (specs/16 Representation); workspace mtime only for
    // files the store has not seen (a brand-new, uncommitted thought).
    const mtime = (await backend.modifiedAt(rel))?.getTime() ?? (await mtimeOf(path.join(backend.workspace, rel)));
    const inFlight = status === 'draft' || staleAfter !== undefined || now.getTime() - mtime <= sinceMs;
    if (!inFlight) continue;
    if (mineUserId !== undefined && !isMine(loc, fm, mineUserId)) continue;
    if (kinds.length > 0 && (loc.kind === undefined || !kinds.includes(loc.kind))) continue;
    const row: StatusRow = {
      path: bundlePath,
      group: groupOf(loc),
      kind: loc.kind ?? '',
      title: typeof fm.title === 'string' && fm.title.trim().length > 0 ? fm.title : path.posix.basename(bundlePath, '.md'),
      status,
      age: formatAge(Math.max(0, now.getTime() - mtime)),
      modifiedAt: new Date(mtime).toISOString(),
      stale: staleAfter !== undefined,
    };
    if (staleAfter !== undefined) row.staleAfter = staleAfter;
    if (staleAfter !== undefined) staleRows.push(row);
    else rows.push(row);
  }

  // --repo: one group only (a repo id, or `shared`).
  const wantedGroup = opts.repo !== undefined ? (opts.repo === 'shared' ? 'shared' : `repos/${opts.repo}`) : undefined;
  const filtered = wantedGroup === undefined ? rows : rows.filter((r) => r.group === wantedGroup);
  const filteredStale = wantedGroup === undefined ? staleRows : staleRows.filter((r) => r.group === wantedGroup);

  // Local, uncommitted brain changes (specs/16: through the backend). The
  // cross-repo warning sees every unsynced edit even under --repo; the
  // displayed sections are scoped to the requested repo.
  const dirty = await backend.dirty();
  const unsyncedAll = dirty
    .map((d) => d.path)
    .filter((p) => p.endsWith('.md') && locate('/' + p) !== undefined && !p.includes('/references/'))
    .sort();
  if (currentRepo !== undefined) {
    // specs/04 cross-repo warning: edits under another repo's `repos/<id>/`.
    const others = [...new Set(unsyncedAll.map((p) => /^repos\/([^/]+)\//.exec(p)?.[1]).filter((id): id is string => id !== undefined && id !== currentRepo))];
    if (others.length > 0) {
      warn(`working-tree edits under another repo's brain directory: ${others.join(', ')}`);
    }
  }
  const unsynced = wantedGroup === undefined ? unsyncedAll : unsyncedAll.filter((p) => groupOf(locate('/' + p)!) === wantedGroup);

  // specs/04 cross-repo warning: resources pointing at a repo not in brain.yml.
  const declaredRepos = brain.repos.map((r) => r.id);
  for (const [id, paths] of [...resourceRepos.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!declaredRepos.includes(id)) {
      warn(`${id} is referenced by ${paths.length} thought${paths.length === 1 ? '' : 's'} (${paths.join(', ')}) but is not in brain.yml`);
    }
  }

  // Brain sync state (specs/04 cross-repo warning 3): warn when the local
  // brain is more than N commits behind the store. N is configurable per
  // brain in global config (`brains.<id>.behind_warning`), default 20.
  const rev = await backend.revision();
  const upstream = await backend.upstreamRevision();
  let drift: StatusResult['drift'];
  if (rev !== undefined && upstream !== undefined && (rev !== upstream || (await backend.behindCount()) !== 0)) {
    const ahead = (await backend.revisionsSince(upstream)).length;
    const behind = (await backend.behindCount()) ?? 0;
    drift = { ahead, behind };
    const threshold = behindWarningThreshold(ctx.global, ctx.brainId ?? path.basename(brainRoot));
    if (behind > threshold) {
      warn(`local brain is ${behind} commits behind the store; run: thoughts sync`);
    } else if (behind === 0 && ahead > 0) {
      warn(`local brain is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of the store; run: thoughts sync`);
    }
  }

  // Current code repo git state, read live (D17) — never fatal.
  let codeRepo: StatusResult['codeRepo'];
  if (ctx.mode === 'repo' && ctx.repoRoot) {
    try {
      codeRepo = { branch: await git.currentBranch(ctx.repoRoot), dirtyFiles: (await git.statusPorcelain(ctx.repoRoot)).length };
    } catch (err) {
      out.debug(`status: code repo git state unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Codegraph section (specs/04 "Codegraph"): stored graphs through the
  // backend, staleness from git only, cross-repo deps by package matching.
  // Never fatal — a failure drops the section, never fails the command.
  const graph: GraphRepoStatus[] = [];
  if (opts.graph !== false) {
    try {
      const graphs = new Map<string, RepoGraph>();
      for (const r of brain.repos) {
        const doc = await backend.loadGraph(r.id);
        const g = doc !== undefined ? deserialize(doc) : undefined;
        if (g !== undefined) graphs.set(r.id, g);
      }
      const packages: Record<string, string | undefined> = {};
      for (const r of brain.repos) {
        const g = graphs.get(r.id);
        packages[r.id] = typeof r.package === 'string' ? r.package : g !== undefined ? ownModuleName(g) : undefined;
      }
      const edges = crossRepoEdges([...graphs.values()], packages);
      const moduleNameById = new Map<string, string>();
      for (const g of graphs.values()) {
        for (const n of g.nodes) if (n.kind === 'module') moduleNameById.set(n.id, n.name);
      }
      for (const r of brain.repos) {
        const g = graphs.get(r.id);
        const deps = (edges.get(r.id) ?? [])
          .map((e) => moduleRepoOf(graphs, e.target))
          .filter((id): id is string => id !== undefined && id !== r.id)
          .sort();
        const entry: GraphRepoStatus = {
          repo_id: r.id,
          files: g?.counts.files ?? 0,
          symbols: g?.counts.symbols ?? 0,
          edges: g?.counts.edges ?? 0,
          fresh: false,
          staleness: 'absent',
          deps,
        };
        if (g !== undefined) {
          entry.codeCommit = g.codeCommit;
          const head = await localHead(ctx.global, brainId, r.id);
          const info = stalenessOf(g, head);
          entry.staleness = info.staleness;
          if (info.staleness === 'fresh') {
            entry.fresh = true;
            entry.code_ahead = 0;
          } else if (info.staleness === 'stale') {
            entry.code_ahead = (await localAhead(ctx.global, brainId, r.id, g.codeCommit)) ?? 0;
          }
        }
        graph.push(entry);
      }
    } catch (err) {
      out.debug(`status: codegraph section unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Assemble groups: current repo first, then brain.yml order, shared, users.
  // A group with only unsynced files still shows, so `sync` stays discoverable.
  const groupNames = [...new Set([...filtered.map((r) => r.group), ...unsynced.map((p) => groupOf(locate('/' + p)!)), ...(wantedGroup !== undefined ? [wantedGroup] : [])])].sort((a, b) => {
    const ra = groupRank(a, declaredRepos, currentRepo);
    const rb = groupRank(b, declaredRepos, currentRepo);
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  const groups: StatusGroup[] = [];
  for (const group of groupNames) {
    const groupUnsynced = unsynced.filter((p) => groupOf(locate('/' + p)!) === group);
    if (filtered.some((r) => r.group === group) || groupUnsynced.length > 0) {
      groups.push({ group, current: group === `repos/${currentRepo}`, rows: filtered.filter((r) => r.group === group), unsynced: groupUnsynced });
    }
  }

  const result: StatusResult = {
    brainRoot,
    brainId: ctx.brainId ?? path.basename(brainRoot),
    brainName: brain.name,
    repoCount: declaredRepos.length,
    groups,
    stale: filteredStale,
    unsynced,
    graph,
    warnings,
  };
  const synced = syncedAge(brainRoot, now);
  if (synced !== undefined) result.synced = synced;
  if (currentRepo !== undefined) result.currentRepo = currentRepo;
  if (codeRepo !== undefined) result.codeRepo = codeRepo;
  if (drift !== undefined) result.drift = drift;

  if (opts.json) out.print(JSON.stringify(result, null, 2));
  else renderHuman(result);
  return result;
}

/** Age of the last regeneration (`log.md` is rewritten by every sync); undefined when unknown. */
function syncedAge(brainRoot: string, now: Date): string | undefined {
  try {
    const st = fs.statSync(path.join(brainRoot, 'log.md'));
    return `synced ${formatAge(Math.max(0, now.getTime() - st.mtimeMs))} ago`;
  } catch {
    return undefined;
  }
}

/** The repo ids of the graphs that own a given module node (cross-repo targets). */
function moduleRepoOf(graphs: Map<string, RepoGraph>, nodeId: string): string | undefined {
  for (const [repoId, g] of graphs) {
    if (g.nodes.some((n) => n.id === nodeId)) return repoId;
  }
  return undefined;
}

/** HEAD of a repo attached on this machine (global config), when reachable. */
async function localHead(global: GlobalConfig, brainId: string, repoId: string): Promise<string | undefined> {
  const dir = localRepoPath(global, brainId, repoId);
  if (dir === undefined) return undefined;
  try {
    if (!(fs.existsSync(dir) && (await git.isInsideWorkTree(dir)) && (await git.hasHead(dir)))) return undefined;
    return await git.headSha(dir);
  } catch {
    return undefined;
  }
}

/** How many commits the repo's HEAD is ahead of the stored graph commit. */
async function localAhead(global: GlobalConfig, brainId: string, repoId: string, stored: string): Promise<number | undefined> {
  const dir = localRepoPath(global, brainId, repoId);
  if (dir === undefined) return undefined;
  try {
    return (await git.revList(dir, stored)).length;
  } catch {
    return undefined;
  }
}

function localRepoPath(global: GlobalConfig, brainId: string, repoId: string): string | undefined {
  const entry = global.attached.find((a) => a.repo_id === repoId && a.brain === brainId);
  return entry?.path;
}

/** Path shown under a group: relative to the group directory, like the spec example. */
function unsyncedDisplayPath(group: string, workspacePath: string): string {
  const prefix = group === 'shared' ? 'shared/' : `${group}/`;
  return workspacePath.startsWith(prefix) ? workspacePath.slice(prefix.length) : workspacePath;
}

function renderHuman(result: StatusResult): void {
  const say = (m: string): void => out.info(m);
  const head = [result.brainName, `${result.repoCount} repo${result.repoCount === 1 ? '' : 's'}`, result.synced].filter((p) => p !== undefined).join(' · ');
  say(head);
  const hasContent = result.groups.some((g) => g.rows.length > 0 || g.unsynced.length > 0) || result.stale.length > 0;
  if (!hasContent) say('nothing to do');
  const width = Math.max(0, ...result.groups.flatMap((g) => g.rows.map((r) => r.title.length)));
  for (const g of result.groups) {
    const label = g.group.startsWith('repos/') ? g.group.slice('repos/'.length) : g.group;
    let suffix = g.current ? ' (you' : '';
    if (g.current && result.codeRepo !== undefined) {
      if (result.codeRepo.branch !== undefined) suffix += ` · ${result.codeRepo.branch}`;
      if (result.codeRepo.dirtyFiles > 0) suffix += ` · ${result.codeRepo.dirtyFiles} uncommitted`;
    }
    if (suffix.length > 0) suffix += ')';
    say('');
    say(label + suffix);
    for (const r of g.rows) {
      say(`  ${r.kind.padEnd(10)}${r.title.padEnd(width)}  ${r.status.padEnd(9)}${r.age}`);
    }
    for (const p of g.unsynced) {
      say(`  ⚠ unsynced: ${unsyncedDisplayPath(g.group, p)}`);
    }
  }
  if (result.stale.length > 0) {
    say('');
    say(`stale (${result.stale.length})`);
    for (const r of result.stale) {
      say(`  ${r.path.slice(1)}   stale_after ${r.staleAfter ?? ''}`.trimEnd());
    }
  }
  renderGraphSection(result, say);
}

/** The Codegraph section (specs/04 "Codegraph"): counts, staleness, cross-repo deps. */
function renderGraphSection(result: StatusResult, say: (m: string) => void): void {
  // specs/04: every declared repo gets a row, even when its graph is absent.
  if (result.graph.length === 0) return;
  say('');
  say('codegraph');
  const width = Math.max(0, ...result.graph.map((g) => g.repo_id.length));
  for (const g of result.graph) {
    const counts = g.staleness === 'absent' ? '' : `  ${formatCounts({ files: g.files, symbols: g.symbols, edges: g.edges })}`;
    say(`  ${g.repo_id.padEnd(width)}${counts}  ${stalenessWord(g.staleness, g.code_ahead)}`);
  }
  const current = result.currentRepo !== undefined ? result.graph.find((g) => g.repo_id === result.currentRepo) : undefined;
  if (current !== undefined && current.deps.length > 0) {
    say(`  cross-repo deps into ${current.repo_id}: ${current.deps.join(', ')}`);
  }
}

function stalenessWord(staleness: GraphStaleness, ahead: number | undefined): string {
  if (staleness === 'stale' && ahead !== undefined) return `stale — ${ahead} commit${ahead === 1 ? '' : 's'} ahead`;
  return staleness;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function register(program: Command): void {
  program
    .command('status')
    .description('What is in flight across the project')
    .option('--repo <id>', 'limit the report to one repo (or "shared"); default is every repo, current first')
    .option('--all', 'report every repo in the brain (the default)')
    .option('--kind <kinds>', 'filter by kind; repeat the flag or comma-separate, e.g. specs,plans', collect, [])
    .option('--mine', 'only thoughts under users/<me>/ or authored by human:<me>')
    .option('--since <duration>', 'how far back modified thoughts count as in flight (default 14d)', '14d')
    .option('--json', 'print one object per row with fields path, group, kind, title, status, age, modifiedAt, stale (+ staleAfter when stale), plus groups, stale, unsynced, synced, drift, warnings')
    .option('--no-integrations', 'skip integration state (tickets, PRs); implied while specs/10 is unimplemented')
    .option('--no-graph', 'skip the codegraph section (specs/04 "Codegraph")')
    .option('--brain <id|url>', 'brain to use when outside a repo')
    .action(async (opts: StatusOptions) => {
      await runStatus(opts, process.cwd());
    });
}
