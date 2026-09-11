/**
 * claude-code adapter (specs/11 "claude-code", specs/08).
 *
 *   Instructions  CLAUDE.md (managed block; written by init via `instructionFile`)
 *   Commands      .claude/commands/thoughts-*.md
 *   Skills        .claude/skills/<name>/SKILL.md      (TODO(milestone 2))
 *   Agents        .claude/agents/thoughts-*.md         (TODO(milestone 2))
 *
 * Never overwrites a user file: a command file without the kit version
 * comment is `modified locally` and left alone unless `force`. Re-runnable.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { KitFileState } from '../types.js';
import { compareVersions, kitFileVersion, KIT_COMMAND_NAMES, renderKitFile, type KitVars } from './kit.js';

export interface KitFileReport {
  /** Path relative to the repo root. */
  file: string;
  state: KitFileState;
  detail?: string;
}

export interface InstallOptions {
  kitVersion: string;
  /** Rendering variables; `kit_version` defaults to `kitVersion`. */
  vars: { brain_name: string; repo_id: string; kit_version?: string; [key: string]: unknown };
  /** `<brain>/standard/` override lookup root. */
  brainRoot?: string;
  dryRun?: boolean;
  force?: boolean;
}

export interface Adapter {
  name(): string;
  detect(repoRoot: string): boolean;
  instructionFile(repoRoot: string): string;
  installCommands(repoRoot: string, opts: InstallOptions): Promise<KitFileReport[]>;
  installSkills(repoRoot: string, opts: InstallOptions & { selected?: string[] }): Promise<KitFileReport[]>;
  installAgents(repoRoot: string, opts: InstallOptions): Promise<KitFileReport[]>;
  verify(repoRoot: string, opts: { kitVersion: string; vars: InstallOptions['vars']; brainRoot?: string }): Promise<KitFileReport[]>;
}

const COMMANDS_DIR = path.join('.claude', 'commands');

/** Compare an installed kit file with the freshly rendered one. */
export function classifyKitFile(existing: string | undefined, rendered: string, kitVersion: string): KitFileState {
  if (existing === undefined) return 'missing';
  const installedVersion = kitFileVersion(existing);
  if (installedVersion === undefined) return 'modified locally';
  if (existing === rendered) return 'up-to-date';
  const cmp = compareVersions(installedVersion, kitVersion);
  if (cmp < 0) return 'outdated';
  if (cmp > 0) return 'up-to-date'; // installed by a newer CLI; leave it
  return 'modified locally';
}

function readIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

async function installCommandFiles(repoRoot: string, opts: InstallOptions, write: boolean): Promise<KitFileReport[]> {
  const vars: KitVars = { ...opts.vars, kit_version: opts.vars.kit_version ?? opts.kitVersion };
  const reports: KitFileReport[] = [];
  for (const name of KIT_COMMAND_NAMES) {
    const rel = path.join(COMMANDS_DIR, name + '.md');
    const abs = path.join(repoRoot, rel);
    const rendered = renderKitFile(opts.brainRoot, vars, 'commands', name + '.md');
    const existing = readIfExists(abs);
    const state = classifyKitFile(existing, rendered, opts.kitVersion);
    if (!write) {
      reports.push({ file: rel, state });
      continue;
    }
    if (state === 'up-to-date') {
      reports.push({ file: rel, state });
      continue;
    }
    if (state === 'missing') {
      if (!opts.dryRun) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, rendered);
      }
      reports.push({ file: rel, state: 'created' });
      continue;
    }
    // outdated or modified locally: only --force replaces it.
    if (opts.force) {
      if (!opts.dryRun) fs.writeFileSync(abs, rendered);
      reports.push({ file: rel, state: 'updated', detail: `was ${state}` });
    } else {
      reports.push({
        file: rel,
        state,
        detail: state === 'outdated' ? 'run: thoughts kit update (or init --force)' : 'left alone; re-run with --force to replace',
      });
    }
  }
  return reports;
}

export const claudeCode: Adapter = {
  name: () => 'claude-code',

  detect(repoRoot: string): boolean {
    return fs.existsSync(path.join(repoRoot, 'CLAUDE.md')) || fs.existsSync(path.join(repoRoot, '.claude'));
  },

  instructionFile(repoRoot: string): string {
    return path.join(repoRoot, 'CLAUDE.md');
  },

  installCommands(repoRoot, opts) {
    return installCommandFiles(repoRoot, opts, true);
  },

  async installSkills(_repoRoot, _opts) {
    // TODO(milestone 2): install .claude/skills/<name>/SKILL.md from kit/skills (specs/08 section 3).
    return [{ file: path.join('.claude', 'skills'), state: 'skipped', detail: 'skills are not in milestone 1' }];
  },

  async installAgents(_repoRoot, _opts) {
    // TODO(milestone 2): install .claude/agents/thoughts-researcher.md and thoughts-writer.md (specs/08 section 4).
    return [{ file: path.join('.claude', 'agents'), state: 'skipped', detail: 'agents are not in milestone 1' }];
  },

  async verify(repoRoot, opts) {
    return installCommandFiles(repoRoot, { kitVersion: opts.kitVersion, vars: opts.vars, brainRoot: opts.brainRoot }, false);
  },
};

export default claudeCode;
