/**
 * `thoughts init` (specs/02) — non-interactive path (`--yes`) for milestone 1.
 *
 * Steps, each a reportable StepReport (specs/02 "Steps"):
 *   0. preflight (platform, git, work tree)
 *   1. resolve the brain (clone / fetch / create per O1), install the brain
 *      clone's pre-commit hook
 *   2. register the repo (brain.yml repos[], repos/<id>/<kind>/, .thoughts.yml)
 *   3. symlink <repo>/thoughts → brain root, gitignore it
 *   4. templates source
 *   5. standard kit per tool adapter (O2 for tool selection)
 *   6. integrations (skipped in milestone 1)
 *   7. secret check on written config
 *   8. initial sync + summary
 *
 * `--dry-run` prints the plan and writes nothing anywhere: no clone, no
 * symlink, no config, no commit. Re-running on an initialised repo reports
 * `up-to-date` everywhere and exits 0.
 *
 * TODO(interactive guide, D15): without `--yes` the per-tool sub-guides of
 * specs/02 are not implemented yet; the command exits 1 with a message.
 */
import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { getAdapter, detectAdapters, KNOWN_TOOLS } from '../adapters/index.js';
import { renderInstructions } from '../adapters/kit.js';
import { upsertManagedBlock } from '../adapters/managed-block.js';
import { assetPath, cliVersion, readAsset } from '../assets.js';
import {
  brainIdFromRemote,
  loadBrainConfig,
  loadGlobalConfig,
  loadRepoConfig,
  saveBrainConfig,
  saveGlobalConfig,
  saveRepoConfig,
} from '../brain/config.js';
import { ensureRepoDirs, registerRepo, scaffoldBrain } from '../brain/layout.js';
import { isCredRef, maskConnectionString } from '../brain/backends/credref.js';
import { connectionRefFor, kindFromRef, resolveBackend } from '../brain/backends/resolve.js';
import { isProvisionable } from '../brain/backends/types.js';
import { writeDockerSnippet } from '../brain/backends/snippet.js';
import { preflight } from '../brain/preflight.js';
import * as git from '../git.js';
import * as out from '../output.js';
import { BRAIN_CONFIG_FILENAME, REPO_CONFIG_FILENAME, SYMLINK_NAME, brainCloneDir, brainsDir } from '../paths.js';
import { hasBlocking, scanFiles, scanText } from '../security/scanner.js';
import { BUILTIN_TEMPLATE_NAMES } from '../templates/resolve.js';
import {
  DEFAULT_KINDS,
  ExitCode,
  ThoughtsError,
  type BackendKind,
  type BrainConfig,
  type Finding,
  type RepoConfig,
  type StepReport,
  type TemplateSource,
} from '../types.js';
import { parseBackendDescriptor } from '../brain/backends/types.js';
import {
  SecretRefusedError,
  assertRepoIdSegment,
  hasUrlCredentials,
  isoTimestamp,
  printWarnings,
  redactUrlCredentials,
  splitList,
  translateGitError,
} from './common.js';
import { runSync, type SyncResult } from './sync.js';
import { stepReportFor } from './codegraph-step.js';

export interface InitOptions {
  brain?: string;
  /** Store backend (specs/16): git (default) | psql | nebula. Immutable after init. */
  backend?: string;
  /** Cred-ref (`env:VAR` / `keyref:name`) for a non-git store (specs/10). */
  connectionRef?: string;
  repoId?: string;
  tools?: string;
  templates?: string;
  skills?: string;
  /** commander `--no-agents` → `agents: false`. */
  agents?: boolean;
  /** commander `--no-commands` → `commands: false`. */
  commands?: boolean;
  integrations?: string;
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  hooks?: boolean;
  json?: boolean;
  now?: Date;
}

export interface InitResult {
  repoRoot: string;
  repoId: string;
  brainId: string;
  /** The value written to `.thoughts.yml` `brain`. */
  brainRemote: string;
  brainRoot: string;
  tools: string[];
  steps: StepReport[];
  dryRun: boolean;
  sync?: SyncResult;
}

const SUPPORTED_PLATFORMS: readonly string[] = ['darwin', 'linux'];
const TEMPLATE_SOURCE_RE = /^(builtin|brain|path:.+|git:.+)$/;

/** Quote a string for POSIX sh (single quotes; embedded quotes escaped). */
function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Absolute path of the CLI entry point (`dist/index.js`), located from this module, never from cwd. */
export function cliEntryPath(): string {
  return assetPath('dist', 'index.js');
}

/**
 * The pre-commit hook installed into the CLI-owned brain clone (specs/15
 * "Where the scan runs"). It fails closed: `thoughts` on PATH, else the node
 * binary and CLI entry that installed it, else the commit is refused (QA-F3).
 */
export function preCommitHookScript(version: string, opts: { node?: string; cli?: string } = {}): string {
  const node = opts.node ?? process.execPath;
  const cli = opts.cli ?? cliEntryPath();
  return [
    '#!/bin/sh',
    `# thoughts-kit v${version} — secret scan of staged files in this brain clone (specs/15).`,
    '# Installed by `thoughts init`; re-installed when missing. Do not edit.',
    'if command -v thoughts >/dev/null 2>&1; then',
    '  exec thoughts scan --staged',
    `elif [ -x ${shQuote(node)} ] && [ -f ${shQuote(cli)} ]; then`,
    `  exec ${shQuote(node)} ${shQuote(cli)} scan --staged`,
    'fi',
    'echo "thoughts: CLI not found; refusing commit — staged files were not scanned for secrets (specs/15)" >&2',
    'exit 1',
    '',
  ].join('\n');
}

/** Refuse a brain remote with an embedded password before anything is written (SEC-F6). */
function assertNoUrlCredentials(remote: string): void {
  if (hasUrlCredentials(remote)) {
    throw new ThoughtsError('brain URL contains embedded credentials', ExitCode.Validation, {
      hint: 'use a git credential helper or an SSH remote',
    });
  }
}

function isUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/@\s]+@[^:/\s]+:/.test(value);
}

function looksLikePath(value: string): boolean {
  return path.isAbsolute(value) || value.startsWith('.') || value.startsWith('~') || value.includes('/');
}

function expandHome(p: string): string {
  if (p === '~') return process.env.HOME ?? p;
  if (p.startsWith('~/')) return path.join(process.env.HOME ?? '', p.slice(2));
  return p;
}

function isEmptyDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/**
 * The CLI-owned clone directory is usable when it is missing, empty, or already
 * a brain clone. Anything else is a foreign directory in the way, and only the
 * user can decide what happens to it.
 */
function assertUsableCloneDir(brainRoot: string): void {
  if (!fs.existsSync(brainRoot)) return;
  if (isEmptyDir(brainRoot)) return;
  if (fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME))) return;
  throw new ThoughtsError(`${brainRoot} exists but is not a brain clone`, ExitCode.FsConflict, {
    hint: `move it away or delete it (rm -rf ${brainRoot}), then re-run: thoughts init`,
  });
}

function readIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/** `repo_id` from a code remote: last path segment without `.git`. */
export function repoIdFromRemote(remote: string): string | undefined {
  try {
    const id = brainIdFromRemote(remote);
    return /^[A-Za-z0-9._-]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

interface BrainRef {
  /** What `.thoughts.yml` `brain` will say. */
  remote: string;
  brainId: string;
  /** A local path that `init` has to create as a new brain (O1). */
  createAt?: string;
  /** True when `remote` is a local non-bare repository (push updates a checked-out branch). */
  localNonBare: boolean;
}

/**
 * Interpret the brain reference: `.thoughts.yml` `brain`, or `--brain` as a
 * scheme ref (`postgres:<id>` / `nebula:<id>`, specs/16), a clone id, a remote
 * URL, or a local path (O1: create it when missing/empty).
 */
async function resolveBrainRef(ref: string, fromRepoConfig: boolean): Promise<BrainRef> {
  const raw = ref.trim();
  assertNoUrlCredentials(raw);
  const schemeKind = kindFromRef(raw);
  if (schemeKind !== undefined) {
    // specs/16 "Credential references": `postgres:<id>` / `nebula:<id>` yield
    // the brain id directly; there is no git remote behind them.
    return { remote: raw, brainId: brainIdFromRemote(raw), localNonBare: false };
  }
  if (isUrl(raw)) {
    const filePath = raw.startsWith('file://') ? raw.slice('file://'.length) : undefined;
    return {
      remote: raw,
      brainId: brainIdFromRemote(raw),
      localNonBare: filePath !== undefined && fs.existsSync(filePath) && !(await git.isBareRepo(filePath)),
    };
  }
  if (looksLikePath(raw)) {
    const abs = path.resolve(expandHome(raw));
    const brainId = brainIdFromRemote(abs);
    if (fs.existsSync(abs) && !isEmptyDir(abs)) {
      if (!(await git.isInsideWorkTree(abs)) && !(await git.isBareRepo(abs))) {
        throw new ThoughtsError(`--brain path is not a git repository: ${abs}`, ExitCode.Validation, {
          hint: 'point --brain at an existing brain repository, or at a new (empty) path to create one',
        });
      }
      const bare = await git.isBareRepo(abs);
      // Refuse a checked-out non-brain here rather than after cloning it: the
      // clone would only be thrown away, and the message names the path the
      // user typed instead of the CLI-owned clone.
      if (!bare && !fs.existsSync(path.join(abs, BRAIN_CONFIG_FILENAME))) {
        throw new ThoughtsError(`${abs} is a git repository but not a brain: ${BRAIN_CONFIG_FILENAME} is missing`, ExitCode.Validation, {
          hint: 'create a brain at a new (empty) path, then push it; or point --brain at an existing brain',
        });
      }
      return { remote: abs, brainId, localNonBare: !bare };
    }
    if (fromRepoConfig) {
      throw new ThoughtsError(`brain path from ${REPO_CONFIG_FILENAME} does not exist: ${abs}`, ExitCode.RemoteUnreachable, {
        hint: 'restore the brain at that path or fix `brain:` in ' + REPO_CONFIG_FILENAME,
      });
    }
    return { remote: abs, brainId, createAt: abs, localNonBare: true };
  }
  // A bare brain id: an existing clone under ~/.thoughts/brains or a known remote in global config.
  const brainId = raw;
  const clone = brainCloneDir(brainId);
  const global = await loadGlobalConfig();
  const known = global.brains[brainId]?.remote;
  if (typeof known === 'string' && known.length > 0) return await resolveBrainRef(known, false);
  if (fs.existsSync(path.join(clone, BRAIN_CONFIG_FILENAME))) {
    const origin = await git.remoteUrl(clone);
    if (origin) return await resolveBrainRef(origin, false);
    return { remote: clone, brainId, localNonBare: true };
  }
  throw new ThoughtsError(`unknown brain "${brainId}"`, ExitCode.Validation, {
    hint: 'pass --brain <remote url> or --brain <local path>; known clones live under ' + brainsDir(),
  });
}

/** O1: create a brand-new brain at `dir` (git init + scaffold + initial commit). */
async function createBrainAt(dir: string, now: Date): Promise<void> {
  const name = path.basename(dir);
  fs.mkdirSync(dir, { recursive: true });
  try {
    await git.init(dir);
    // Let clones push back into this checked-out repository (`thoughts sync` pushes).
    await git.git(['config', 'receive.denyCurrentBranch', 'updateInstead'], { cwd: dir });
    await scaffoldBrain(dir, { name, now });
    await git.addAll(dir);
    await git.commit(dir, `thoughts: create brain ${name}`);
  } catch (err) {
    throw translateGitError(err, 'other');
  }
}

function report(steps: StepReport[], step: string, state: StepReport['state'], detail?: string): void {
  const r: StepReport = { step, state };
  if (detail) r.detail = detail;
  steps.push(r);
}

function printSummary(steps: StepReport[]): void {
  out.info('');
  const width = Math.max(...steps.map((s) => s.state.length), 10);
  for (const s of steps) {
    out.info(`  ${s.state.padEnd(width)}  ${s.step}${s.detail ? '  (' + s.detail + ')' : ''}`);
  }
}

function toolSelection(opts: InitOptions, existing: RepoConfig | undefined, repoRoot: string): string[] {
  const flag = splitList(opts.tools);
  if (flag.length > 0) return flag;
  if (existing && existing.tools.length > 0) return [...existing.tools];
  const detected = detectAdapters(repoRoot);
  if (detected.length > 0) return detected;
  return ['claude-code'];
}

export async function runInit(opts: InitOptions, cwd: string): Promise<InitResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const version = cliVersion();
  const steps: StepReport[] = [];
  const write = !dryRun;

  // ---- 0. Preflight ------------------------------------------------------
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    throw new ThoughtsError(`thoughts supports macOS and Linux only; ${process.platform} is unsupported in v1 (D4)`, ExitCode.Validation);
  }
  if (!(await git.isGitAvailable())) {
    throw new ThoughtsError('git is not on PATH', ExitCode.Validation, { hint: 'install git and re-run: thoughts init' });
  }
  if (!(await git.isInsideWorkTree(cwd))) {
    throw new ThoughtsError('not inside a git work tree', ExitCode.Validation, {
      hint: 'run `git init` (or cd into your code repo), then re-run: thoughts init',
    });
  }
  const repoRoot = realpathOr(await git.topLevel(cwd));
  const ctx = await preflight(cwd, { command: 'init', brain: opts.brain, cliVersion: version });
  printWarnings(ctx);
  if (!opts.yes) {
    // TODO(interactive guide, D15): per-tool sub-guides after a short common section.
    throw new ThoughtsError('interactive guide not implemented yet; re-run with --yes', ExitCode.Validation, {
      hint: 'thoughts init --yes [--brain <url|path>] [--tools claude-code]',
    });
  }
  if (opts.hooks) {
    // TODO(milestone 2): opt-in post-checkout/post-merge banner hooks in the code repo (specs/02 "Optional git hooks").
    report(steps, 'code repo git hooks', 'skipped', 'not in milestone 1');
  }
  report(steps, 'preflight', 'done', `${process.platform}, git ${(await git.git(['--version'], { cwd })).stdout.trim().replace(/^git version /, '')}`);

  // ---- 1. Resolve the brain -----------------------------------------------
  const existingRepo = await loadRepoConfig(repoRoot);
  let brainRef: BrainRef;
  if (existingRepo) {
    if (opts.brain && opts.brain.trim() !== existingRepo.brain) {
      out.warn(
        `${REPO_CONFIG_FILENAME} already names brain ${redactUrlCredentials(existingRepo.brain)}; ignoring --brain ${redactUrlCredentials(opts.brain)}`,
      );
    }
    brainRef = await resolveBrainRef(existingRepo.brain, true);
  } else if (opts.brain) {
    brainRef = await resolveBrainRef(opts.brain, false);
  } else if (ctx.global.default_brain && fs.existsSync(path.join(brainCloneDir(ctx.global.default_brain), BRAIN_CONFIG_FILENAME))) {
    // `--yes` accepts defaults: the default brain from global config (specs/02 step 1.3, "pick from brains in global config").
    // With --json this note must not land on stdout (contract §7).
    const note = `using default brain ${ctx.global.default_brain} (pass --brain to choose another)`;
    if (opts.json) out.warn(note);
    else out.info(note);
    brainRef = await resolveBrainRef(ctx.global.default_brain, false);
  } else {
    throw new ThoughtsError('--brain is required with --yes when the repo has no ' + REPO_CONFIG_FILENAME, ExitCode.Validation, {
      hint: 'thoughts init --yes --brain <remote url | local path>',
    });
  }
  const { brainId, remote: brainRemote } = brainRef;
  let remote = brainRemote;
  const brainRoot = brainCloneDir(brainId);
  const brainConfigSoFar = fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME)) ? await loadBrainConfig(brainRoot) : undefined;
  const requestedBackend = opts.backend?.trim().toLowerCase();
  if (requestedBackend !== undefined && requestedBackend !== 'git' && requestedBackend !== 'psql' && requestedBackend !== 'nebula') {
    throw new ThoughtsError(`invalid --backend value "${requestedBackend}"`, ExitCode.Validation, {
      hint: 'use git (default), psql or nebula (specs/16-brain-backends.md)',
    });
  }
  const descriptor = parseBackendDescriptor(brainConfigSoFar?.backend);
  const kind = descriptor?.kind ?? kindFromRef(remote) ?? (requestedBackend as BackendKind | undefined) ?? 'git';
  if (descriptor !== undefined && requestedBackend !== undefined && requestedBackend !== 'git' && descriptor.kind !== requestedBackend) {
    throw new ThoughtsError(`brain ${brainId} uses the ${descriptor.kind} backend; a brain's backend is immutable (specs/16)`, ExitCode.Validation, {
      hint: `drop --backend ${requestedBackend}`,
    });
  }
  if (kind !== 'git' && kindFromRef(remote) === undefined) {
    // A plain id or path: make the stored ref carry the scheme so every later
    // command resolves the same backend (specs/16 "Credential references").
    if (brainRef.createAt !== undefined || looksLikePath(remote)) {
      throw new ThoughtsError(`--backend ${kind} needs a brain ref like ${kind === 'nebula' ? 'nebula' : 'postgres'}:${brainId}, not a local git path`, ExitCode.Validation, {
        hint: 'a psql/nebula brain has no git remote; name it with the scheme and a brain id',
      });
    }
    remote = `${kind === 'nebula' ? 'nebula' : 'postgres'}:${brainId}`;
    brainRef.remote = remote;
  }
  // specs/16 "Credential references": a --connection-ref is a *ref*, never the
  // connection string itself. A pasted literal is refused here — before
  // anything connects and before the global config could persist it — and the
  // message carries the value only masked.
  const connectionRef = opts.connectionRef?.trim();
  if (kind !== 'git' && connectionRef !== undefined && connectionRef.length > 0 && !isCredRef(connectionRef)) {
    throw new ThoughtsError(`invalid connection reference "${maskConnectionString(connectionRef)}"`, ExitCode.Validation, {
      hint: '--connection-ref takes a cred-ref (env:<VARNAME> or keyref:<name>); set the connection string itself in the environment or the key store',
    });
  }
  const shownRemote = redactUrlCredentials(remote);
  // Resolve the backend before anything is written (specs/16): a missing
  // connection ref is exit 1 naming the env var, with nothing provisioned.
  const backend = await resolveBackend({ brainId, workspace: brainRoot, brain: brainConfigSoFar, brainRef: remote, connectionRef: opts.connectionRef });
  // Before anything is written: a foreign directory where the clone belongs
  // must fail here, not after a new brain has been scaffolded at `--brain <path>`.
  assertUsableCloneDir(brainRoot);
  let brainCreated = false;
  if (brainRef.createAt && kind === 'git') {
    if (write) {
      await createBrainAt(brainRef.createAt, now);
      brainCreated = true;
      report(steps, `brain ${brainId} at ${brainRef.createAt}`, 'created');
    } else {
      report(steps, `brain ${brainId} at ${brainRef.createAt}`, 'dry-run', 'would create a new brain');
    }
  }

  let fetchFailed = false;
  if (kind !== 'git') {
    // specs/16 "Provisioning": connect + provision, then materialise the
    // workspace. The store is reachable or init stops here with a snippet.
    if (!isProvisionable(backend)) {
      throw new ThoughtsError(`backend "${kind}" cannot provision a store`, ExitCode.Validation);
    }
    const shownRef = maskConnectionString(opts.connectionRef?.trim() ?? (await connectionRefFor({ brainId, workspace: brainRoot, brainRef: remote }, kind)));
    if (!write) {
      report(steps, `store ${kind} ${brainId}`, 'dry-run', `connection ${shownRef}`);
      report(steps, `brain workspace ${brainRoot}`, 'dry-run', 'would materialise from the store');
    } else {
      const existedBefore = fs.existsSync(brainRoot);
      fs.mkdirSync(brainRoot, { recursive: true });
      // The non-secret object name (specs/16 "brain.yml backend block"):
      // psql's database, nebula's space — the backend's own, never derived
      // from the connection string.
      const storeName = await backend.storeName();
      try {
        const provisioned = await backend.provision();
        report(steps, `store ${kind} ${storeName}`, 'up-to-date', `schema ${provisioned.version}, connection ${shownRef}`);
        await backend.materialise();
        if (!fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME))) {
          await scaffoldBrain(brainRoot, { name: brainId, now });
          const fresh = await loadBrainConfig(brainRoot);
          await saveBrainConfig(brainRoot, { ...fresh, backend: kind === 'nebula' ? { kind, space: storeName } : { kind, database: storeName } });
        }
        report(steps, `brain workspace ${brainRoot}`, 'created', 'materialised from the store');
      } catch (err) {
        // A failed connect+provision leaves nothing behind: an empty workspace
        // would look like a foreign directory to every later `init` (specs/02).
        if (!existedBefore && !fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME))) fs.rmSync(brainRoot, { recursive: true, force: true });
        if (err instanceof ThoughtsError && err.exitCode === ExitCode.RemoteUnreachable) {
          // specs/02/16: an unreachable store prints a ready-to-run snippet and
          // exits 2; the CLI never starts anything itself.
          // Name the env var the user's cred-ref points at, so the snippet's
          // export line is the one they actually run (specs/10).
          const envVar = /^env:([A-Za-z0-9_.-]+)$/.exec((opts.connectionRef ?? '').trim())?.[1];
          const snippet = writeDockerSnippet(brainId, kind, storeName, envVar);
          out.warn(`store unreachable; wrote a ready-to-run docker snippet: ${snippet}`);
        }
        throw err;
      }
    }
  } else {
    const cloneHasBrain = fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME));
    if (cloneHasBrain) {
      if (await git.hasRemote(brainRoot)) {
        try {
          await git.fetch(brainRoot);
          report(steps, `brain clone ${brainRoot}`, 'up-to-date', 'fetched');
        } catch (err) {
          fetchFailed = true;
          const e = translateGitError(err, 'fetch', remote);
          out.warn(`could not fetch brain ${brainId}: ${e.message}`);
          report(steps, `brain clone ${brainRoot}`, 'up-to-date', 'fetch failed; working offline');
        }
      } else {
        report(steps, `brain clone ${brainRoot}`, 'up-to-date');
      }
    } else if (write) {
      assertUsableCloneDir(brainRoot);
      if (isEmptyDir(brainRoot)) fs.rmdirSync(brainRoot);
      fs.mkdirSync(brainsDir(), { recursive: true });
      try {
        await git.clone(remote, brainRoot);
      } catch (err) {
        // Whatever a partial clone left behind is ours to remove: kept, it looks
        // like a foreign directory and blocks every later `init` for this brain.
        fs.rmSync(brainRoot, { recursive: true, force: true });
        throw translateGitError(err, 'clone', remote);
      }
      if (!fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME))) {
        fs.rmSync(brainRoot, { recursive: true, force: true });
        throw new ThoughtsError(`${shownRemote} is not a brain: ${BRAIN_CONFIG_FILENAME} is missing`, ExitCode.Validation, {
          hint: 'point --brain at a brain repository, or at a new (empty) path to create one',
        });
      }
      report(steps, `brain clone ${brainRoot}`, 'created', `from ${shownRemote}`);
    } else {
      report(steps, `brain clone ${brainRoot}`, 'dry-run', `would clone ${shownRemote}`);
    }
  }
  const haveBrain = fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME));
  const brain: BrainConfig | undefined = haveBrain ? await loadBrainConfig(brainRoot) : undefined;
  const brainName = brain?.name ?? brainId;
  const kinds = brain?.kinds ?? DEFAULT_KINDS;

  // Pre-commit hook in the CLI-owned clone (always; re-installed when missing).
  // TODO(scan): `thoughts scan --staged` is the milestone-1 subset in src/commands/scan.ts.
  // specs/16: the hook is git-only — a non-git store has no hook to install;
  // scanning happens inside `sync` instead.
  if (kind !== 'git') {
    report(steps, 'brain pre-commit hook', 'skipped', 'git-only; scanning happens inside sync (specs/16)');
  } else if (haveBrain) {
    const hookPath = path.join(await git.hooksDir(brainRoot), 'pre-commit');
    const script = preCommitHookScript(version);
    const existingHook = readIfExists(hookPath);
    if (existingHook === script) {
      report(steps, 'brain pre-commit hook', 'up-to-date');
    } else if (existingHook !== undefined && !existingHook.includes('thoughts-kit')) {
      report(steps, 'brain pre-commit hook', 'modified locally', 'a foreign hook is installed; left alone');
    } else if (write) {
      fs.mkdirSync(path.dirname(hookPath), { recursive: true });
      fs.writeFileSync(hookPath, script, { mode: 0o755 });
      fs.chmodSync(hookPath, 0o755);
      report(steps, 'brain pre-commit hook', existingHook === undefined ? 'created' : 'updated');
    } else {
      report(steps, 'brain pre-commit hook', 'dry-run');
    }
  } else {
    report(steps, 'brain pre-commit hook', 'dry-run', 'after clone');
  }

  // ---- 2. Register the repo -------------------------------------------------
  const codeRemote = await git.remoteUrl(repoRoot);
  const repoId =
    opts.repoId?.trim() ||
    existingRepo?.repo_id ||
    (codeRemote ? repoIdFromRemote(codeRemote) : undefined) ||
    path.basename(repoRoot);
  // SEC-F1: a repo id is one path segment; `..` and separators are refused.
  assertRepoIdSegment(repoId, 'repo id');
  const tools = toolSelection(opts, existingRepo, repoRoot);
  for (const t of tools) {
    if (!KNOWN_TOOLS.includes(t)) out.warn(`unknown tool "${t}"; known tools: ${KNOWN_TOOLS.join(', ')}`);
  }
  const toolsUnion = [...(existingRepo?.tools ?? [])];
  for (const t of tools) if (!toolsUnion.includes(t)) toolsUnion.push(t);

  if (haveBrain && write) {
    const entry: { id: string; remote?: string } = { id: repoId };
    if (codeRemote) entry.remote = codeRemote;
    const changed = await registerRepo(brainRoot, entry);
    report(steps, `brain.yml repos[] ${repoId}`, changed ? 'created' : 'up-to-date');
    const created = await ensureRepoDirs(brainRoot, repoId, kinds);
    report(steps, `repos/${repoId}/{${Object.keys(kinds).join(',')}}`, created.length > 0 ? 'created' : 'up-to-date');
  } else {
    const registered = brain?.repos.some((r) => r.id === repoId) ?? false;
    report(steps, `brain.yml repos[] ${repoId}`, registered ? 'up-to-date' : 'dry-run');
    report(steps, `repos/${repoId}/{${Object.keys(kinds).join(',')}}`, 'dry-run');
  }

  const newRepoCfg: RepoConfig = {
    ...(existingRepo ?? {}),
    brain: existingRepo?.brain ?? remote,
    repo_id: repoId,
    tools: toolsUnion,
    kit_version: version,
  };
  const repoCfgUnchanged =
    existingRepo !== undefined &&
    existingRepo.brain === newRepoCfg.brain &&
    existingRepo.repo_id === newRepoCfg.repo_id &&
    existingRepo.kit_version === newRepoCfg.kit_version &&
    sameStringSet(existingRepo.tools, newRepoCfg.tools);
  if (repoCfgUnchanged) {
    report(steps, REPO_CONFIG_FILENAME, 'up-to-date');
  } else if (write) {
    await saveRepoConfig(repoRoot, newRepoCfg);
    report(steps, REPO_CONFIG_FILENAME, existingRepo ? 'updated' : 'created');
  } else {
    report(steps, REPO_CONFIG_FILENAME, 'dry-run', existingRepo ? 'would update' : 'would create');
  }

  // ---- 3. Symlink + .gitignore ---------------------------------------------
  const link = path.join(repoRoot, SYMLINK_NAME);
  let lst: fs.Stats | undefined;
  try {
    lst = fs.lstatSync(link);
  } catch {
    lst = undefined;
  }
  const expectedTarget = realpathOr(brainRoot);
  if (lst === undefined) {
    if (write) {
      fs.symlinkSync(brainRoot, link);
      report(steps, `${SYMLINK_NAME} → ${brainRoot}`, 'created');
    } else {
      report(steps, `${SYMLINK_NAME} → ${brainRoot}`, 'dry-run');
    }
  } else if (lst.isSymbolicLink()) {
    const actual = (() => {
      try {
        return fs.realpathSync(link);
      } catch {
        return undefined;
      }
    })();
    if (actual === expectedTarget) {
      report(steps, `${SYMLINK_NAME} → ${brainRoot}`, 'up-to-date');
    } else if (opts.force) {
      if (write) {
        fs.unlinkSync(link);
        fs.symlinkSync(brainRoot, link);
      }
      report(steps, `${SYMLINK_NAME} → ${brainRoot}`, write ? 'updated' : 'dry-run', `was → ${fs.readlinkSync(link)}`);
    } else {
      throw new ThoughtsError(`${link} is a symlink to ${fs.readlinkSync(link)}, not to brain ${brainId}`, ExitCode.FsConflict, {
        hint: 'remove it or re-run with --force to repoint it',
      });
    }
  } else if (lst.isDirectory() && isEmptyDir(link)) {
    if (opts.force) {
      if (write) {
        fs.rmdirSync(link);
        fs.symlinkSync(brainRoot, link);
      }
      report(steps, `${SYMLINK_NAME} → ${brainRoot}`, write ? 'updated' : 'dry-run', 'replaced empty directory');
    } else {
      throw new ThoughtsError(`${link} exists and is an empty directory, not a symlink`, ExitCode.FsConflict, {
        hint: 'remove it or re-run with --force',
      });
    }
  } else {
    throw new ThoughtsError(`${link} exists and is not a symlink; refusing to touch it`, ExitCode.FsConflict, {
      hint: 'move it away, then re-run: thoughts init (--force never deletes user content)',
    });
  }

  const gitignorePath = path.join(repoRoot, '.gitignore');
  const gitignore = readIfExists(gitignorePath);
  const ignored = (gitignore ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === '/' + SYMLINK_NAME || l === SYMLINK_NAME || l === '/' + SYMLINK_NAME + '/' || l === SYMLINK_NAME + '/');
  if (ignored) {
    report(steps, '.gitignore /' + SYMLINK_NAME, 'up-to-date');
  } else if (write) {
    const eol = gitignore !== undefined && /\r\n/.test(gitignore) ? '\r\n' : '\n';
    let prefix = gitignore ?? '';
    if (prefix.length > 0 && !prefix.endsWith('\n')) prefix += eol;
    fs.writeFileSync(gitignorePath, prefix + '/' + SYMLINK_NAME + eol);
    report(steps, '.gitignore /' + SYMLINK_NAME, gitignore === undefined ? 'created' : 'updated');
  } else {
    report(steps, '.gitignore /' + SYMLINK_NAME, 'dry-run');
  }

  // ---- 4. Templates ----------------------------------------------------------
  const requestedSource = opts.templates?.trim();
  if (requestedSource !== undefined && !TEMPLATE_SOURCE_RE.test(requestedSource)) {
    throw new ThoughtsError(`invalid --templates value "${requestedSource}"`, ExitCode.Validation, {
      hint: 'use builtin, brain, path:<dir> or git:<url>',
    });
  }
  const source = (requestedSource ?? brain?.templates.source ?? 'builtin') as TemplateSource;
  if (brain && haveBrain) {
    if (brain.templates.source !== source) {
      if (write) {
        await saveBrainConfig(brainRoot, { ...brain, templates: { ...brain.templates, source } });
        brain.templates.source = source;
      }
      report(steps, `templates.source ${source}`, write ? 'updated' : 'dry-run', `was ${brain.templates.source}`);
    } else {
      report(steps, `templates.source ${source}`, 'up-to-date');
    }
    if (source === 'brain') {
      const dir = path.join(brainRoot, 'templates');
      const hasAny = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.md'));
      if (hasAny) {
        report(steps, 'brain templates/', 'up-to-date');
      } else if (write) {
        fs.mkdirSync(dir, { recursive: true });
        for (const name of BUILTIN_TEMPLATE_NAMES) fs.writeFileSync(path.join(dir, name + '.md'), readAsset('templates', name + '.md'));
        report(steps, 'brain templates/', 'created', 'copied built-in templates');
      } else {
        report(steps, 'brain templates/', 'dry-run', 'would copy built-in templates');
      }
    }
  } else {
    report(steps, `templates.source ${source}`, 'dry-run');
  }

  // ---- 5. Standard kit -------------------------------------------------------
  const kitVars = { brain_name: brainName, repo_id: repoId, kit_version: version };
  const kitBrainRoot = haveBrain ? brainRoot : undefined;
  for (const tool of tools) {
    const adapter = getAdapter(tool);
    if (!adapter) {
      report(steps, `kit ${tool}`, 'skipped', 'adapter not in milestone 1');
      continue;
    }
    const file = adapter.instructionFile(repoRoot);
    const rel = path.relative(repoRoot, file);
    const existingText = readIfExists(file);
    const block = renderInstructions(kitBrainRoot, kitVars);
    const upsert = upsertManagedBlock(existingText, block, rel);
    if (upsert.state === 'up-to-date') {
      report(steps, `${tool} ${rel} managed block`, 'up-to-date');
    } else if (write) {
      try {
        fs.writeFileSync(file, upsert.content);
      } catch (err) {
        throw new ThoughtsError(`cannot write ${file}: ${(err as Error).message}`, ExitCode.FsConflict, {
          hint: 'make the instruction file writable, then re-run: thoughts init',
        });
      }
      report(steps, `${tool} ${rel} managed block`, upsert.state);
    } else {
      report(steps, `${tool} ${rel} managed block`, 'dry-run', `would be ${upsert.state}`);
    }

    if (opts.commands === false) {
      report(steps, `${tool} commands`, 'skipped', '--no-commands');
    } else {
      const installOpts: Parameters<typeof adapter.installCommands>[1] = { kitVersion: version, vars: kitVars, dryRun, force: opts.force === true };
      if (kitBrainRoot) installOpts.brainRoot = kitBrainRoot;
      for (const r of await adapter.installCommands(repoRoot, installOpts)) {
        report(steps, `${tool} ${r.file}`, dryRun && (r.state === 'created' || r.state === 'updated') ? 'dry-run' : r.state, r.detail);
      }
    }

    const skills = opts.skills?.trim();
    if (skills === undefined || skills === 'none') {
      report(steps, `${tool} skills`, 'skipped', skills === 'none' ? '--skills none' : 'not selected');
    } else {
      const installOpts: Parameters<typeof adapter.installSkills>[1] = { kitVersion: version, vars: kitVars, dryRun, selected: splitList(skills) };
      if (kitBrainRoot) installOpts.brainRoot = kitBrainRoot;
      for (const r of await adapter.installSkills(repoRoot, installOpts)) report(steps, `${tool} ${r.file}`, r.state, r.detail);
    }
    if (opts.agents === false) {
      report(steps, `${tool} agents`, 'skipped', '--no-agents');
    } else {
      const installOpts: Parameters<typeof adapter.installAgents>[1] = { kitVersion: version, vars: kitVars, dryRun };
      if (kitBrainRoot) installOpts.brainRoot = kitBrainRoot;
      for (const r of await adapter.installAgents(repoRoot, installOpts)) report(steps, `${tool} ${r.file}`, r.state, r.detail);
    }
  }

  // ---- 6. Integrations -------------------------------------------------------
  for (const integration of splitList(opts.integrations)) {
    // TODO(milestone 2): integration setup per specs/10.
    report(steps, `integration ${integration}`, 'skipped', 'not in milestone 1');
  }

  // ---- 7. Secret check on written config -----------------------------------
  let findings: Finding[] = [];
  if (write) {
    findings = findings.concat(await scanFiles(repoRoot, [REPO_CONFIG_FILENAME]));
    if (haveBrain) findings = findings.concat(await scanFiles(brainRoot, [BRAIN_CONFIG_FILENAME]));
  } else {
    findings = findings.concat(scanText(YAML.stringify(newRepoCfg), '/' + REPO_CONFIG_FILENAME));
    if (haveBrain) findings = findings.concat(await scanFiles(brainRoot, [BRAIN_CONFIG_FILENAME]));
  }
  if (hasBlocking(findings)) throw new SecretRefusedError(findings, 'continue');
  for (const f of findings) out.warn(`${f.path}:${f.line}: possible secret (${f.kind}) ${f.masked}`);
  report(steps, 'secret check (.thoughts.yml, brain.yml)', 'done', 'clean');

  // ---- Global config ---------------------------------------------------------
  if (write) {
    const global = await loadGlobalConfig();
    const attachedPath = realpathOr(repoRoot);
    const already = global.attached.find((a) => a.path === attachedPath);
    if (already) {
      already.repo_id = repoId;
      already.brain = brainId;
    } else {
      global.attached.push({ path: attachedPath, repo_id: repoId, brain: brainId, initialised_at: isoTimestamp(now) });
    }
    global.brains[brainId] = { ...(global.brains[brainId] ?? {}), remote };
    if (kind !== 'git') {
      // specs/10/16: the cred-ref (never the secret) lives in the global
      // config, outside the brain, so every later command resolves it.
      const ref = connectionRef ?? (await connectionRefFor({ brainId, workspace: brainRoot, brainRef: remote }, kind));
      global.brains[brainId]['connection_ref'] = ref;
    }
    if (!global.default_brain) global.default_brain = brainId;
    await saveGlobalConfig(global);
    report(steps, 'global config attached[]', already ? 'up-to-date' : 'updated');
  } else {
    report(steps, 'global config attached[]', 'dry-run');
  }

  // ---- 8. Initial sync + report ---------------------------------------------
  let sync: SyncResult | undefined;
  if (write) {
    const remoteConfigured = (await backend.remoteUrl()) !== undefined;
    // Pushing into a checked-out local repo only works for brains we created
    // (receive.denyCurrentBranch=updateInstead); otherwise commit locally only.
    const pushable = remoteConfigured && !fetchFailed && (!brainRef.localNonBare || brainCreated);
    // The inner sync prints nothing itself; its outcome becomes a row of the
    // summary table (and the `sync` field of the JSON report).
    const syncOpts: Parameters<typeof runSync>[0] = { push: pushable, quiet: true };
    if (fetchFailed) syncOpts.pushOnly = true; // offline: commit locally, no pull
    sync = await runSync(syncOpts, repoRoot);
    report(
      steps,
      'initial sync',
      'done',
      sync.committed ? `committed ${sync.committed.slice(0, 7)}${sync.pushed ? ', pushed' : ''}` : 'nothing to commit',
    );
    // The graph is built at init (specs/17 "When the graph is built"), inside
    // the initial sync's codegraph step; the row reports its outcome.
    const graphRow = stepReportFor(repoId, sync.codegraph);
    report(steps, graphRow.step, graphRow.state, graphRow.detail);
  } else {
    report(steps, 'initial sync', 'dry-run');
    report(steps, `codegraph ${repoId}`, 'dry-run');
  }

  const result: InitResult = { repoRoot, repoId, brainId, brainRemote: remote, brainRoot, tools, steps, dryRun };
  if (sync) result.sync = sync;
  if (opts.json) {
    out.print(JSON.stringify(result, null, 2));
  } else {
    printSummary(steps);
    out.info('');
    out.info(dryRun ? 'dry run: nothing was written' : `repo ${repoId} is attached to brain ${brainId} (${brainRoot})`);
  }
  return result;
}

export function register(program: Command): void {
  program
    .command('init')
    .description('Attach this repo to a brain and install the standard kit')
    .option('--brain <url|id|path>', 'brain remote URL, clone id, or local path (created when missing)')
    .option('--backend <kind>', 'store backend (specs/16): git (default) | psql | nebula; immutable after init')
    .option('--connection-ref <ref>', 'cred-ref for a non-git store, e.g. env:BRAIN_PG (specs/10; never a connection string)')
    .option('--repo-id <id>', 'repo id inside the brain (default: remote name or directory name)')
    .option('--tools <list>', 'comma-separated AI tools: claude-code,codex,pi')
    .option('--templates <source>', 'template source: builtin | brain | path:<dir> | git:<url>')
    .option('--skills <list>', 'skills to install: all | none | <name,...>')
    .option('--no-agents', 'do not install agent definitions')
    .option('--no-commands', 'do not install slash commands')
    .option('--integrations <list>', 'comma-separated integrations (not in milestone 1)')
    .option('--hooks', 'install code-repo git hooks (not in milestone 1)')
    .option('-y, --yes', 'accept defaults and values from .thoughts.yml; never prompt')
    .option('--force', 'repoint an existing thoughts symlink and replace outdated kit files')
    .option('--dry-run', 'print the plan without touching disk')
    .option('--json', 'print the report as JSON')
    .action(async (opts: InitOptions) => {
      await runInit(opts, process.cwd());
    });
}
