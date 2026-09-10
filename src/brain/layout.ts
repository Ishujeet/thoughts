/**
 * Brain layout: locating thoughts, finding roots, scaffolding a brain
 * (specs/01 "Brain layout", "Rules").
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { BRAIN_CONFIG_FILENAME, REPO_CONFIG_FILENAME } from '../paths.js';
import { DEFAULT_KINDS, ExitCode, OKF_VERSION, ThoughtsError, type BrainConfig, type BrainRepoEntry, type KindConfig, type RepoConfig } from '../types.js';
import { ID_HINT, isValidRepoId } from './ids.js';
import { renderIndexes } from './generate.js';

export { locate } from './location.js';

// ---------------------------------------------------------------------------
// Root discovery
// ---------------------------------------------------------------------------

function findUp(cwd: string, marker: string): string | undefined {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Nearest ancestor (inclusive) containing `.thoughts.yml`. */
export function findRepoRoot(cwd: string): string | undefined {
  return findUp(cwd, REPO_CONFIG_FILENAME);
}

/** Nearest ancestor (inclusive) containing `brain.yml`. */
export function findBrainRoot(cwd: string): string | undefined {
  return findUp(cwd, BRAIN_CONFIG_FILENAME);
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

/** Write `content` to `<root>/<rel>` unless it exists. Returns true when created. */
async function createIfMissing(root: string, rel: string, content: string): Promise<boolean> {
  const file = path.join(root, rel);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.promises.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export interface ScaffoldOptions {
  name: string;
  description?: string;
  /** Reserved for timestamped content; the scaffold itself is time-independent. */
  now?: Date;
}

/** The `brain.yml` a fresh brain gets. */
export function defaultBrainConfig(opts: { name: string; description?: string }): BrainConfig {
  const cfg: BrainConfig = {
    okf_version: OKF_VERSION,
    kind: 'project',
    name: opts.name,
    repos: [],
    kinds: { ...DEFAULT_KINDS },
    templates: { source: 'builtin' },
  };
  if (opts.description !== undefined && opts.description.length > 0) {
    // keep `description` right after `name` in the file
    return {
      okf_version: cfg.okf_version,
      kind: cfg.kind,
      name: cfg.name,
      description: opts.description,
      repos: cfg.repos,
      kinds: cfg.kinds,
      templates: cfg.templates,
    };
  }
  return cfg;
}

/**
 * Create the files of an empty brain. Never overwrites, never runs git.
 * Returns the bundle-relative paths (leading slash) that were created.
 */
export async function scaffoldBrain(root: string, opts: ScaffoldOptions): Promise<string[]> {
  const created: string[] = [];
  const brain = defaultBrainConfig(opts);
  await fs.promises.mkdir(root, { recursive: true });

  const add = async (rel: string, content: string): Promise<void> => {
    if (await createIfMissing(root, rel, content)) created.push('/' + rel);
  };

  await add(BRAIN_CONFIG_FILENAME, YAML.stringify(brain, { lineWidth: 0 }));
  const indexes = renderIndexes([], brain);
  await add('index.md', indexes['/index.md'] ?? '');
  await add('log.md', '# Log\n\n');
  await add('shared/index.md', indexes['/shared/index.md'] ?? '');
  for (const kind of ['plans', 'specs', 'research', 'decisions']) {
    await add(path.join('shared', kind, '.gitkeep'), '');
  }
  await add(path.join('repos', '.gitkeep'), '');
  await add(path.join('users', '.gitkeep'), '');
  return created;
}

/** Ids joined into brain paths must be a single opaque segment (no `/`, `..`, …). */
function assertPathSegment(id: string, what: string): void {
  if (!isValidRepoId(id)) {
    throw new ThoughtsError('invalid ' + what + ': ' + id, ExitCode.Validation, { hint: ID_HINT });
  }
}

/** `repos/<id>/<kind>/.gitkeep` for every kind. Returns created bundle-relative paths. */
export async function ensureRepoDirs(brainRoot: string, repoId: string, kinds: Record<string, KindConfig>): Promise<string[]> {
  assertPathSegment(repoId, 'repo id');
  const created: string[] = [];
  for (const kind of Object.keys(kinds)) {
    assertPathSegment(kind, 'kind name');
    const rel = path.join('repos', repoId, kind, '.gitkeep');
    if (await createIfMissing(brainRoot, rel, '')) created.push('/' + rel);
  }
  return created;
}

/**
 * Append `entry` to `brain.yml` `repos[]` when its id is missing. This is the
 * only automated edit to `brain.yml` (specs/01). Comments and key order of the
 * existing file are preserved. Returns true when the file changed.
 */
export async function registerRepo(brainRoot: string, entry: BrainRepoEntry): Promise<boolean> {
  assertPathSegment(entry.id, 'repo id');
  const file = path.join(brainRoot, BRAIN_CONFIG_FILENAME);
  const text = await fs.promises.readFile(file, 'utf8');
  const doc = YAML.parseDocument(text);
  const repos = doc.get('repos');
  const clean: Record<string, unknown> = { id: entry.id };
  for (const [k, v] of Object.entries(entry)) if (k !== 'id' && v !== undefined) clean[k] = v;

  if (YAML.isSeq(repos)) {
    for (const item of repos.items) {
      if (YAML.isMap(item) && item.get('id') === entry.id) return false;
    }
    repos.flow = false;
    repos.add(doc.createNode(clean));
  } else {
    const seq = doc.createNode([clean]) as YAML.YAMLSeq;
    seq.flow = false;
    doc.set('repos', seq);
  }
  await fs.promises.writeFile(file, doc.toString({ lineWidth: 0 }), 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// Kit version
// ---------------------------------------------------------------------------

function versionParts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split(/[-+]/)[0]!
    .split('.')
    .map((s) => Number.parseInt(s, 10))
    .map((n) => (Number.isNaN(n) ? 0 : n));
}

/** Compare dotted numeric versions: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** True when the installed kit is older than the CLI; a missing `kit_version` counts as outdated. */
export function kitOutdated(repo: RepoConfig, cliVersion: string): boolean {
  if (typeof repo.kit_version !== 'string' || repo.kit_version.trim().length === 0) return true;
  return compareVersions(repo.kit_version, cliVersion) < 0;
}
