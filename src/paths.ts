/**
 * Well-known locations (specs/01 "Locations"). Supervisor-owned.
 *
 * Environment overrides exist so tests never touch the real home directory:
 *   THOUGHTS_HOME        -> replaces ~/.thoughts          (brain clones, template cache)
 *   THOUGHTS_CONFIG_DIR  -> replaces ~/.config/thoughts   (global config.yml)
 * Setting HOME to a temp dir also works, since both defaults derive from it.
 */
import os from 'node:os';
import path from 'node:path';

export function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}

/** `~/.thoughts` */
export function thoughtsHome(): string {
  return process.env.THOUGHTS_HOME ?? path.join(homeDir(), '.thoughts');
}

/** `~/.thoughts/brains` */
export function brainsDir(): string {
  return path.join(thoughtsHome(), 'brains');
}

/** `~/.thoughts/brains/<brain-id>` */
export function brainCloneDir(brainId: string): string {
  return path.join(brainsDir(), brainId);
}

/** `~/.thoughts/templates` — cache for `git:<url>` template sources. */
export function templatesCacheDir(): string {
  return path.join(thoughtsHome(), 'templates');
}

/** `~/.config/thoughts` (honours XDG_CONFIG_HOME) */
export function configDir(): string {
  if (process.env.THOUGHTS_CONFIG_DIR) return process.env.THOUGHTS_CONFIG_DIR;
  const xdg = process.env.XDG_CONFIG_HOME;
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(homeDir(), '.config'), 'thoughts');
}

/** `~/.config/thoughts/config.yml` */
export function globalConfigPath(): string {
  return path.join(configDir(), 'config.yml');
}

export const REPO_CONFIG_FILENAME = '.thoughts.yml';
export const BRAIN_CONFIG_FILENAME = 'brain.yml';
export const ALLOW_LIST_FILENAME = '.thoughts-allow.yml';
export const SYMLINK_NAME = 'thoughts';
