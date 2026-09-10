/**
 * Configuration chain (specs/01 "Locations", "brain.yml", "<repo>/.thoughts.yml",
 * "Future: org-level brains").
 *
 * Every loader preserves unknown keys and every writer keeps a stable key
 * order so that a rewrite never reorders a hand-edited file at random.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { BRAIN_CONFIG_FILENAME, REPO_CONFIG_FILENAME, brainCloneDir, configDir, globalConfigPath } from '../paths.js';
import {
  DEFAULT_KINDS,
  ExitCode,
  OKF_VERSION,
  ThoughtsError,
  type BrainConfig,
  type GlobalConfig,
  type KindConfig,
  type RepoConfig,
  type ResolvedConfig,
} from '../types.js';
import { ID_HINT, isValidRepoId, sanitiseId } from './ids.js';
import { findBrainRoot, findRepoRoot } from './layout.js';

export { isValidRepoId } from './ids.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// YAML helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readYamlFile(file: string): Promise<{ exists: boolean; data: unknown }> {
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, data: undefined };
    throw err;
  }
  try {
    return { exists: true, data: YAML.parse(text) };
  } catch (err) {
    throw new ThoughtsError('cannot parse ' + file + ': ' + (err as Error).message, ExitCode.Validation, {
      hint: 'fix the YAML syntax in ' + file,
      cause: err,
    });
  }
}

/**
 * Serialise an object with `known` keys first (in that order), then every other
 * key in alphabetical order. Undefined values are dropped.
 */
function stableYaml(obj: Record<string, unknown>, known: readonly string[]): string {
  const ordered: Record<string, unknown> = {};
  for (const key of known) {
    if (obj[key] !== undefined) ordered[key] = obj[key];
  }
  const rest = Object.keys(obj)
    .filter((k) => !known.includes(k) && obj[k] !== undefined)
    .sort();
  for (const key of rest) ordered[key] = obj[key];
  return YAML.stringify(ordered, { lineWidth: 0 });
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content, 'utf8');
}

// ---------------------------------------------------------------------------
// Global config  ~/.config/thoughts/config.yml
// ---------------------------------------------------------------------------

const GLOBAL_KEYS = ['user_id', 'default_brain', 'brains', 'attached'] as const;

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const { exists, data } = await readYamlFile(globalConfigPath());
  if (!exists || data === null || data === undefined) return { brains: {}, attached: [] };
  if (!isRecord(data)) {
    throw new ThoughtsError('global config is not a mapping: ' + globalConfigPath(), ExitCode.Validation);
  }
  const cfg: GlobalConfig = { ...data, brains: {}, attached: [] };
  if (isRecord(data.brains)) cfg.brains = data.brains as GlobalConfig['brains'];
  if (Array.isArray(data.attached)) cfg.attached = data.attached as GlobalConfig['attached'];
  return cfg;
}

export async function saveGlobalConfig(cfg: GlobalConfig): Promise<void> {
  await fs.promises.mkdir(configDir(), { recursive: true });
  await writeFileAtomic(globalConfigPath(), stableYaml(cfg, GLOBAL_KEYS));
}

// ---------------------------------------------------------------------------
// Repo config  <repo>/.thoughts.yml
// ---------------------------------------------------------------------------

const REPO_KEYS = ['brain', 'repo_id', 'tools', 'kit_version', 'project'] as const;

export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig | undefined> {
  const file = path.join(repoRoot, REPO_CONFIG_FILENAME);
  const { exists, data } = await readYamlFile(file);
  if (!exists) return undefined;
  if (!isRecord(data)) {
    throw new ThoughtsError('invalid repo config: ' + file + ' is not a mapping', ExitCode.Validation, {
      hint: 'expected keys: brain, repo_id, tools',
    });
  }
  for (const key of ['brain', 'repo_id'] as const) {
    const v = data[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new ThoughtsError('invalid repo config: ' + file + ' is missing ' + key, ExitCode.Validation, {
        hint: 'add `' + key + ':` to ' + REPO_CONFIG_FILENAME + ' or re-run: thoughts init --force',
      });
    }
  }
  // repo_id is joined into `<brain>/repos/<id>/…`: it must be one opaque segment.
  if (!isValidRepoId(data.repo_id as string)) {
    throw new ThoughtsError('invalid repo config: ' + file + ' has an invalid repo_id', ExitCode.Validation, {
      hint: ID_HINT,
    });
  }
  const tools = Array.isArray(data.tools) ? data.tools.filter((t): t is string => typeof t === 'string') : [];
  const cfg: RepoConfig = { ...data, brain: data.brain as string, repo_id: data.repo_id as string, tools };
  if (typeof data.kit_version === 'number') cfg.kit_version = String(data.kit_version);
  return cfg;
}

export async function saveRepoConfig(repoRoot: string, cfg: RepoConfig): Promise<void> {
  await writeFileAtomic(path.join(repoRoot, REPO_CONFIG_FILENAME), stableYaml(cfg, REPO_KEYS));
}

// ---------------------------------------------------------------------------
// Brain config  <brain>/brain.yml
// ---------------------------------------------------------------------------

const BRAIN_KEYS = [
  'okf_version',
  'kind',
  'name',
  'description',
  'repos',
  'kinds',
  'integrations',
  'templates',
  'security',
  'hooks',
] as const;

function normaliseKinds(value: unknown, file: string): Record<string, KindConfig> | undefined {
  if (!isRecord(value)) return undefined;
  const kinds: Record<string, KindConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    // Kind names become `<brain>/<zone>/<kind>/` directories.
    if (!isValidRepoId(name)) {
      throw new ThoughtsError('invalid brain config: ' + file + ' has an invalid kind name: ' + name, ExitCode.Validation, {
        hint: ID_HINT,
      });
    }
    if (isRecord(raw) && typeof raw.template === 'string') {
      kinds[name] = { ...raw, template: raw.template };
    } else if (typeof raw === 'string') {
      kinds[name] = { template: raw };
    } else {
      // `plans:` with no value — fall back to a template named like the kind minus a trailing `s`.
      kinds[name] = { template: name.endsWith('s') ? name.slice(0, -1) : name };
    }
  }
  return Object.keys(kinds).length > 0 ? kinds : undefined;
}

export async function loadBrainConfig(brainRoot: string): Promise<BrainConfig> {
  const file = path.join(brainRoot, BRAIN_CONFIG_FILENAME);
  const { exists, data } = await readYamlFile(file);
  if (!exists) {
    throw new ThoughtsError('not a brain: ' + file + ' is missing', ExitCode.Validation, {
      hint: 'run `thoughts init` inside a code repo, or pass --brain <url|id>',
    });
  }
  if (!isRecord(data)) {
    throw new ThoughtsError('invalid brain config: ' + file + ' is not a mapping', ExitCode.Validation);
  }
  if (typeof data.name !== 'string' || data.name.trim().length === 0) {
    throw new ThoughtsError('invalid brain config: ' + file + ' is missing name', ExitCode.Validation, {
      hint: 'add `name: <brain name>` to brain.yml',
    });
  }
  const templatesRaw = isRecord(data.templates) ? data.templates : {};
  const source = typeof templatesRaw.source === 'string' && templatesRaw.source.length > 0 ? templatesRaw.source : 'builtin';
  const cfg: BrainConfig = {
    ...data,
    okf_version: typeof data.okf_version === 'string' ? data.okf_version : String(data.okf_version ?? OKF_VERSION),
    kind: data.kind === 'org' ? 'org' : 'project',
    name: data.name,
    repos: Array.isArray(data.repos)
      ? (data.repos.filter((r) => isRecord(r) && typeof r.id === 'string') as BrainConfig['repos'])
      : [],
    kinds: normaliseKinds(data.kinds, file) ?? { ...DEFAULT_KINDS },
    templates: { ...templatesRaw, source: source as BrainConfig['templates']['source'] },
  };
  return cfg;
}

export async function saveBrainConfig(brainRoot: string, cfg: BrainConfig): Promise<void> {
  await writeFileAtomic(path.join(brainRoot, BRAIN_CONFIG_FILENAME), stableYaml(cfg, BRAIN_KEYS));
}

// ---------------------------------------------------------------------------
// Brain id
// ---------------------------------------------------------------------------

/**
 * Brain id = last path segment of the remote without a `.git` suffix.
 * Works for ssh (`git@host:org/name.git`), https, `file://` and plain paths.
 */
export function brainIdFromRemote(remote: string): string {
  let s = remote.trim();
  // strip trailing slashes
  while (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) s = s.slice(0, -1);
  if (s.endsWith('.git')) s = s.slice(0, -4);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  const lastSlash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  let seg = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  // scp-like `git@host:name` without a slash
  const colon = seg.lastIndexOf(':');
  if (colon >= 0) seg = seg.slice(colon + 1);
  if (seg.length === 0) {
    throw new ThoughtsError('cannot derive a brain id from remote: ' + remote, ExitCode.Validation, {
      hint: 'pass --brain <id> or use a remote URL that ends in a repository name',
    });
  }
  // The id names the clone directory `~/.thoughts/brains/<id>`: one opaque segment only.
  if (!isValidRepoId(seg)) {
    throw new ThoughtsError('cannot derive a brain id from remote: ' + remote, ExitCode.Validation, {
      hint: 'the repository name must ' + ID_HINT,
    });
  }
  return seg;
}

/** True when the string looks like a URL or a filesystem path rather than a bare id. */
function looksLikeRemote(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes('/') || value.includes(':') || value.startsWith('~');
}

/**
 * Resolve a `--brain` value (id, remote URL, or path) to a brain root
 * directory when one can be found on disk. Returns `undefined` otherwise.
 */
export function resolveBrainRootFromRef(ref: string): { brainId: string; brainRoot: string } | undefined {
  const brainId = brainIdFromRemote(ref);
  const candidates: string[] = [];
  // A path to a brain checkout (or its clone) may be used directly.
  if (looksLikeRemote(ref) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) && !/^[^/]+@[^:]+:/.test(ref)) {
    candidates.push(path.resolve(ref));
  } else if (ref.startsWith('file://')) {
    candidates.push(ref.slice('file://'.length));
  }
  candidates.push(brainCloneDir(brainId));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, BRAIN_CONFIG_FILENAME))) return { brainId, brainRoot: dir };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Lookup chain: repo -> project brain -> (org brain) -> global
// ---------------------------------------------------------------------------

export async function resolveConfig(cwd: string, opts: { brain?: string } = {}): Promise<ResolvedConfig> {
  const global = await loadGlobalConfig();
  const resolved: ResolvedConfig = { global, globalPath: globalConfigPath() };

  // Link 1: the code repo's `.thoughts.yml`.
  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    const repo = await loadRepoConfig(repoRoot);
    if (repo) {
      resolved.repo = repo;
      resolved.repoPath = path.join(repoRoot, REPO_CONFIG_FILENAME);
    }
  }

  // Link 2: the project brain. `--brain` wins over `.thoughts.yml`, which wins
  // over "cwd is inside a brain clone", which wins over `default_brain`.
  let brainRoot: string | undefined;
  if (opts.brain) {
    brainRoot = resolveBrainRootFromRef(opts.brain)?.brainRoot;
  } else if (resolved.repo) {
    brainRoot = brainCloneDir(brainIdFromRemote(resolved.repo.brain));
  } else {
    brainRoot = findBrainRoot(cwd);
    if (!brainRoot && global.default_brain) {
      brainRoot = resolveBrainRootFromRef(global.default_brain)?.brainRoot;
    }
  }
  if (brainRoot && fs.existsSync(path.join(brainRoot, BRAIN_CONFIG_FILENAME))) {
    resolved.brain = await loadBrainConfig(brainRoot);
    resolved.brainPath = path.join(brainRoot, BRAIN_CONFIG_FILENAME);
  }

  // Link 3: org brain. Reserved (specs/01 "Future: org-level brains", D3).
  // In v1 this slot is a no-op: an org brain would be found by walking up
  // from the project brain root to a `brain.yml` with `kind: org` and its
  // settings would sit between the project brain and the global config.

  // Link 4: global config is always present (loaded above).
  return resolved;
}

// ---------------------------------------------------------------------------
// Default user id
// ---------------------------------------------------------------------------

async function gitUserEmail(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'user.email'], { timeout: 5000 });
    const email = stdout.trim();
    return email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `global.user_id` → git `user.email` local part → OS username.
 *
 * The result names `<brain>/users/<id>/`, so it must be a single path segment.
 * An explicit `user_id` that is not one is a configuration error; derived
 * values are sanitised (disallowed characters become `-`) and skipped when
 * nothing valid remains.
 */
export async function defaultUserId(global: GlobalConfig): Promise<string> {
  if (typeof global.user_id === 'string' && global.user_id.trim().length > 0) {
    const id = global.user_id.trim();
    if (!isValidRepoId(id)) {
      throw new ThoughtsError('invalid global config: ' + globalConfigPath() + ' has an invalid user_id', ExitCode.Validation, {
        hint: ID_HINT,
      });
    }
    return id;
  }
  const email = await gitUserEmail();
  if (email) {
    const at = email.indexOf('@');
    const local = sanitiseId(at > 0 ? email.slice(0, at) : email);
    if (local.length > 0) return local;
  }
  let username = '';
  try {
    username = os.userInfo().username;
  } catch {
    username = process.env.USER ?? '';
  }
  return sanitiseId(username) || 'unknown';
}
