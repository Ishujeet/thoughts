/**
 * Shared preflight: detects where a command runs and enforces the
 * "attached, not initialised" rule (specs/02, D14).
 */
import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_CONFIG_FILENAME, SYMLINK_NAME, brainCloneDir } from '../paths.js';
import { ExitCode, ThoughtsError, type Context, type PreflightFn } from '../types.js';
import { brainIdFromRemote, loadBrainConfig, loadGlobalConfig, loadRepoConfig, resolveBrainRootFromRef } from './config.js';
import { findBrainRoot, findRepoRoot, kitOutdated } from './layout.js';

/** Commands that may run in an attached-not-initialised repo. */
export const EXEMPT_COMMANDS: readonly string[] = ['init', 'doctor', 'help', 'version'];

async function realpathOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return undefined;
  }
}

/**
 * attached-not-initialised := `.thoughts.yml` exists AND (`<repo>/thoughts` is
 * missing OR not a symlink OR does not resolve to `~/.thoughts/brains/<id>`
 * OR that clone has no `brain.yml`).
 */
export async function isInitialised(repoRoot: string, expectedBrainRoot: string): Promise<boolean> {
  const link = path.join(repoRoot, SYMLINK_NAME);
  let lst: fs.Stats;
  try {
    lst = await fs.promises.lstat(link);
  } catch {
    return false; // missing
  }
  if (!lst.isSymbolicLink()) return false;
  if (!fs.existsSync(path.join(expectedBrainRoot, BRAIN_CONFIG_FILENAME))) return false;
  const [actual, expected] = await Promise.all([realpathOrUndefined(link), realpathOrUndefined(expectedBrainRoot)]);
  if (actual === undefined || expected === undefined) return false;
  return actual === expected;
}

export const preflight: PreflightFn = async (cwd, options) => {
  const global = await loadGlobalConfig();
  const ctx: Context = { mode: 'none', cwd, global, warnings: [] };

  // 1. Inside a code repo attached to a brain?
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    const repoConfig = await loadRepoConfig(repoRoot);
    if (repoConfig) {
      const brainId = brainIdFromRemote(repoConfig.brain);
      const expected = brainCloneDir(brainId);
      ctx.mode = 'repo';
      ctx.repoRoot = repoRoot;
      ctx.repoConfig = repoConfig;
      ctx.brainId = brainId;

      const initialised = await isInitialised(repoRoot, expected);
      if (!initialised) {
        if (!EXEMPT_COMMANDS.includes(options.command)) {
          throw new ThoughtsError(
            'This repo is attached to brain ' + brainId + ' but not initialised on this machine.',
            ExitCode.NotInitialised,
            { hint: 'Run: thoughts init' },
          );
        }
        // Exempt command: report what we know; the brain may or may not exist yet.
        if (fs.existsSync(path.join(expected, BRAIN_CONFIG_FILENAME))) {
          ctx.brainRoot = expected;
          ctx.brainConfig = await loadBrainConfig(expected);
        }
        return ctx;
      }

      ctx.brainRoot = expected;
      ctx.brainConfig = await loadBrainConfig(expected);
      if (options.cliVersion && kitOutdated(repoConfig, options.cliVersion)) {
        ctx.warnings.push(
          'Kit is outdated (installed ' + (repoConfig.kit_version ?? 'none') + ', CLI ' + options.cliVersion + '). Run: thoughts kit update',
        );
      }
      return ctx;
    }
  }

  // 2. Inside a brain clone?
  const brainRoot = findBrainRoot(cwd);
  if (brainRoot) {
    ctx.mode = 'brain';
    ctx.brainRoot = brainRoot;
    ctx.brainConfig = await loadBrainConfig(brainRoot);
    ctx.brainId = path.basename(brainRoot);
    return ctx;
  }

  // 3. Neither: `--brain` or `default_brain` may still name a clone.
  const ref = options.brain ?? global.default_brain;
  if (ref) {
    const found = resolveBrainRootFromRef(ref);
    if (found) {
      ctx.brainRoot = found.brainRoot;
      ctx.brainId = found.brainId;
      ctx.brainConfig = await loadBrainConfig(found.brainRoot);
    }
  }
  return ctx;
};
