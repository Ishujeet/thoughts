/**
 * `thoughts scan [--staged] [--history] [--json]` — the specs/15 "Where the
 * scan runs" surface. Used by the pre-commit hook `init` installs in the brain
 * clone (`thoughts scan --staged`) and by hand on a whole brain.
 *
 * `--history` (specs/15 "If a secret was already pushed") walks the store's
 * revisions through the brain backend and reports findings per revision. A git
 * brain has every commit; a psql brain has the append-only history; a nebula
 * brain has a bounded change log only, and says so before scanning rather than
 * pretend (specs/16). TODO(milestone 2): `--fix`,
 * `--allow <fingerprint> --reason`.
 * `--staged` scans the working-tree content of the staged paths (the index
 * content itself is not read); good enough for the hook, noted as a TODO.
 */
import type { Command } from 'commander';
import path from 'node:path';
import { cliVersion } from '../assets.js';
import { loadBrainConfig } from '../brain/config.js';
import { isCodegraphPath, locate } from '../brain/location.js';
import { resolveBackend } from '../brain/backends/resolve.js';
import { preflight } from '../brain/preflight.js';
import * as git from '../git.js';
import * as out from '../output.js';
import { loadAllowList } from '../security/allowlist.js';
import { formatFindings } from '../security/format.js';
import { hasBlocking, scanFiles, scanText, scanTree } from '../security/scanner.js';
import { ExitCode, ThoughtsError, type BrainConfig, type Finding, type ScanOptions } from '../types.js';
import { SecretRefusedError, printWarnings } from './common.js';

export interface ScanCommandOptions {
  staged?: boolean;
  /** Walk the store's revisions (specs/15 "If a secret was already pushed"). */
  history?: boolean;
  json?: boolean;
  brain?: string;
}

export interface ScanResult {
  brainRoot: string;
  scanned: 'staged' | 'tree' | 'history';
  /** Revisions walked (`--history` only); absent when the history is partial. */
  revisions?: number;
  /** True when the backend's history is a bounded window, not every revision (specs/16). */
  historyPartial?: boolean;
  findings: Finding[];
}

async function stagedPaths(root: string): Promise<string[]> {
  const r = await git.git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root });
  return r.stdout
    .split('\0')
    .filter((p) => p.length > 0)
    // specs/17: generated codegraph data is never scanned.
    .filter((p) => !isCodegraphPath('/' + p.replace(/^\/+/, '')));
}

export async function runScan(opts: ScanCommandOptions, cwd: string): Promise<ScanResult> {
  const ctx = await preflight(cwd, { command: 'scan', brain: opts.brain, cliVersion: cliVersion() });
  printWarnings(ctx);
  if (!ctx.brainRoot) {
    throw new ThoughtsError('no brain found', ExitCode.Validation, {
      hint: 'run inside an initialised repo or a brain clone, or pass --brain <id>',
    });
  }
  const brainRoot = ctx.brainRoot;
  const brain = ctx.brainConfig ?? (await loadBrainConfig(brainRoot));
  const scanOpts: ScanOptions = { allow: await loadAllowList(brainRoot) };
  if (brain.security?.patterns) scanOpts.customPatterns = brain.security.patterns;
  if (brain.security?.entropy !== undefined) scanOpts.entropy = brain.security.entropy;

  let findings: Finding[];
  if (opts.staged) {
    const paths = await stagedPaths(brainRoot);
    findings = paths.length > 0 ? await scanFiles(brainRoot, paths, scanOpts) : [];
    return finish({ brainRoot, scanned: 'staged', findings }, opts);
  }
  if (opts.history) {
    return finish(await historyScan(brainRoot, ctx.brainId ?? path.basename(brainRoot), brain, scanOpts), opts);
  }
  findings = await scanTree(brainRoot, scanOpts);
  return finish({ brainRoot, scanned: 'tree', findings }, opts);
}

/**
 * specs/15 "If a secret was already pushed": walk the store's revisions
 * through the backend and scan every thought document each revision carries.
 * A backend whose history is a bounded window (specs/16, nebula) says so
 * before the scan, so nobody reads "nothing found" as "never was there".
 */
async function historyScan(brainRoot: string, brainId: string, brain: BrainConfig, scanOpts: ScanOptions): Promise<ScanResult> {
  const backend = await resolveBackend({
    brainId,
    workspace: brainRoot,
    brain,
  });
  if (backend.historyMode === 'partial') {
    out.warn('this brain keeps a bounded change log, not a full history (specs/16): only the retained revisions are scanned');
  }
  const head = await backend.revision();
  if (head === undefined) return { brainRoot, scanned: 'history', revisions: 0, historyPartial: backend.historyMode === 'partial', findings: [] };
  const revisions = (await backend.revisionsSince('0')).slice().reverse();
  const paths = (await backend.listThoughts()).filter((p) => locate('/' + p) !== undefined && !p.includes('/references/'));
  const findings: Finding[] = [];
  for (const revision of revisions) {
    for (const rel of paths) {
      const doc = await backend.read(rel, { revision });
      if (doc === undefined) continue; // not present (or pruned) at this revision
      findings.push(...scanText(doc, `${rel}@${revision}`, scanOpts));
    }
  }
  return { brainRoot, scanned: 'history', revisions: revisions.length, historyPartial: backend.historyMode === 'partial', findings };
}

/** Report + exit code, shared by all three scan modes. */
function finish(result: ScanResult, opts: ScanCommandOptions): ScanResult {
  const { findings } = result;
  if (opts.json) {
    out.print(formatFindings(findings, { json: true }));
    if (hasBlocking(findings)) throw new SecretRefusedError(findings, 'commit', { silent: true });
    return result;
  }
  if (hasBlocking(findings)) {
    // specs/15: findings from history print the recovery order and stop.
    if (result.scanned === 'history') {
      out.warn('recovery order (specs/15):');
      out.warn('  1. rotate the credential now — assume it is compromised');
      out.warn('  2. redact it in the working tree and run: thoughts sync');
      out.warn('  3. if history rewriting is wanted, do it with git tooling and force-push, then every teammate re-clones the brain');
    }
    throw new SecretRefusedError(findings, 'commit');
  }
  for (const f of findings) out.warn(`${f.path}:${f.line}: possible secret (${f.kind}) ${f.masked}`);
  out.info(findings.length === 0 ? 'no secrets found' : `${findings.length} warning${findings.length === 1 ? '' : 's'}, nothing blocking`);
  return result;
}

export function register(program: Command): void {
  program
    .command('scan')
    .description('Scan the brain (or its staged files) for secrets')
    .option('--staged', 'scan only files staged in the brain clone (used by the pre-commit hook)')
    .option('--history', 'walk the store\'s revisions and scan every thought document in each (specs/15)')
    .option('--json', 'print findings as JSON')
    .option('--brain <id|url>', 'brain to use when outside a repo')
    .action(async (opts: ScanCommandOptions) => {
      await runScan(opts, process.cwd());
    });
}
