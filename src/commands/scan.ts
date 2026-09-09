/**
 * `thoughts scan [--staged] [--json]` — milestone-1 subset of specs/15
 * "Where the scan runs". Used by the pre-commit hook `init` installs in the
 * brain clone (`thoughts scan --staged`) and by hand on a whole brain.
 *
 * TODO(milestone 2): `--history`, `--fix`, `--allow <fingerprint> --reason`.
 * `--staged` scans the working-tree content of the staged paths (the index
 * content itself is not read); good enough for the hook, noted as a TODO.
 */
import type { Command } from 'commander';
import { cliVersion } from '../assets.js';
import { loadBrainConfig } from '../brain/config.js';
import { preflight } from '../brain/preflight.js';
import * as git from '../git.js';
import * as out from '../output.js';
import { loadAllowList } from '../security/allowlist.js';
import { formatFindings } from '../security/format.js';
import { hasBlocking, scanFiles, scanTree } from '../security/scanner.js';
import { ExitCode, ThoughtsError, type Finding, type ScanOptions } from '../types.js';
import { SecretRefusedError, printWarnings } from './common.js';

export interface ScanCommandOptions {
  staged?: boolean;
  json?: boolean;
  brain?: string;
}

export interface ScanResult {
  brainRoot: string;
  scanned: 'staged' | 'tree';
  findings: Finding[];
}

async function stagedPaths(root: string): Promise<string[]> {
  const r = await git.git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: root });
  return r.stdout.split('\0').filter((p) => p.length > 0);
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
  } else {
    findings = await scanTree(brainRoot, scanOpts);
  }
  const result: ScanResult = { brainRoot, scanned: opts.staged ? 'staged' : 'tree', findings };

  if (opts.json) {
    out.print(formatFindings(findings, { json: true }));
    if (hasBlocking(findings)) throw new SecretRefusedError(findings, 'commit', { silent: true });
    return result;
  }
  if (hasBlocking(findings)) throw new SecretRefusedError(findings, 'commit');
  for (const f of findings) out.warn(`${f.path}:${f.line}: possible secret (${f.kind}) ${f.masked}`);
  out.info(findings.length === 0 ? 'no secrets found' : `${findings.length} warning${findings.length === 1 ? '' : 's'}, nothing blocking`);
  return result;
}

export function register(program: Command): void {
  program
    .command('scan')
    .description('Scan the brain (or its staged files) for secrets')
    .option('--staged', 'scan only files staged in the brain clone (used by the pre-commit hook)')
    .option('--json', 'print findings as JSON')
    .option('--brain <id|url>', 'brain to use when outside a repo')
    .action(async (opts: ScanCommandOptions) => {
      await runScan(opts, process.cwd());
    });
}
