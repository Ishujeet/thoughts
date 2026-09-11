/**
 * Template resolution (specs/07 "Resolution order").
 *
 *   1. `--template <path>` on the command line,
 *   2. `brain.yml` templates.source: builtin | brain | path:<dir> | git:<url>,
 *   3. builtin fallback with one warning when the chosen source lacks the file.
 *
 * There is no per-repo override (D19).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assetExists, readAsset } from '../assets.js';
import * as git from '../git.js';
import * as out from '../output.js';
import { templatesCacheDir } from '../paths.js';
import { BUILTIN_TYPES, ExitCode, ThoughtsError, type BrainConfig, type TemplateSource } from '../types.js';

export type ResolvedSource = 'override' | 'builtin' | 'brain' | 'path' | 'git';

export interface ResolvedTemplate {
  content: string;
  /** Absolute path of the file that was read (for error messages). */
  path: string;
  source: ResolvedSource;
}

export interface ResolveOptions {
  brainRoot?: string;
  brain?: BrainConfig;
  /** `--template <path>`: a file path, wins over everything. */
  override?: string;
  /** Working directory used to resolve a relative `override`. */
  cwd?: string;
}

export const BUILTIN_TEMPLATE_NAMES: readonly string[] = Object.keys(BUILTIN_TYPES);

const warnedSources = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedSources.has(key)) return;
  warnedSources.add(key);
  out.warn(message);
}

/** Test hook: forget which fallback warnings were already printed. */
export function resetTemplateWarnings(): void {
  warnedSources.clear();
}

export function templateCacheDirFor(url: string): string {
  return path.join(templatesCacheDir(), createHash('sha1').update(url).digest('hex'));
}

/**
 * Clone or refresh a `git:<url>` template source into the cache. Returns the
 * directory, or undefined when the remote is unreachable (caller falls back).
 * TODO(milestone 2): refresh on `sync` instead of on every resolution (specs/07).
 */
async function ensureGitSource(url: string): Promise<string | undefined> {
  const dir = templateCacheDirFor(url);
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      try {
        await git.git(['pull', '--ff-only', '--quiet'], { cwd: dir });
      } catch (err) {
        out.debug(`template cache refresh failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return dir;
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git.clone(url, dir);
    return dir;
  } catch (err) {
    out.debug(`template source clone failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

function readIfExists(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function builtin(name: string): ResolvedTemplate {
  const file = name + '.md';
  if (!assetExists('templates', file)) {
    throw new ThoughtsError(`unknown template "${name}"`, ExitCode.Validation, {
      hint: 'built-in templates: ' + BUILTIN_TEMPLATE_NAMES.join(', ') + '; add <name>.md to the brain template source for org kinds',
    });
  }
  return { content: readAsset('templates', file), path: path.join('<builtin>', file), source: 'builtin' };
}

export async function resolveTemplate(name: string, opts: ResolveOptions = {}): Promise<ResolvedTemplate> {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    throw new ThoughtsError(`invalid template name "${name}"`, ExitCode.Validation);
  }
  if (opts.override !== undefined) {
    const abs = path.resolve(opts.cwd ?? process.cwd(), opts.override);
    const content = readIfExists(abs);
    if (content === undefined) {
      throw new ThoughtsError(`template not found: ${opts.override}`, ExitCode.Validation, {
        hint: '--template takes a path to a markdown file',
      });
    }
    return { content, path: abs, source: 'override' };
  }

  const source: TemplateSource = opts.brain?.templates?.source ?? 'builtin';
  const file = name + '.md';

  if (source === 'builtin') return builtin(name);

  let dir: string | undefined;
  let kind: ResolvedSource = 'builtin';
  if (source === 'brain') {
    dir = opts.brainRoot ? path.join(opts.brainRoot, 'templates') : undefined;
    kind = 'brain';
  } else if (source.startsWith('path:')) {
    const raw = source.slice('path:'.length);
    dir = path.isAbsolute(raw) ? raw : path.resolve(opts.brainRoot ?? process.cwd(), raw);
    kind = 'path';
  } else if (source.startsWith('git:')) {
    dir = await ensureGitSource(source.slice('git:'.length));
    kind = 'git';
  } else {
    throw new ThoughtsError(`unsupported templates.source "${String(source)}" in brain.yml`, ExitCode.Validation, {
      hint: 'use builtin, brain, path:<dir> or git:<url>',
    });
  }

  if (dir !== undefined) {
    const abs = path.join(dir, file);
    const content = readIfExists(abs);
    if (content !== undefined) return { content, path: abs, source: kind };
  }
  const fallback = builtin(name);
  warnOnce(`${source}:${name}`, `template source ${source} has no ${file}; using the built-in template`);
  return fallback;
}
