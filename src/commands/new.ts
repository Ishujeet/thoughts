/**
 * `thoughts new <kind> <title>` (specs/06): create a thought from a template.
 *
 * YAML safety: the built-in templates write `title: "{{title}}"`, so the
 * `title` variable is pre-escaped for a YAML double-quoted scalar (`\` and
 * `"`) before rendering. Body headings use the same variable; titles with
 * quotes or backslashes are rare enough that the escaped form is acceptable.
 */
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cliVersion } from '../assets.js';
import { defaultUserId, loadBrainConfig } from '../brain/config.js';
import { locate } from '../brain/layout.js';
import { parseFrontmatter, serializeThought } from '../brain/okf.js';
import { preflight } from '../brain/preflight.js';
import * as git from '../git.js';
import * as out from '../output.js';
import { hasBlocking, scanText } from '../security/scanner.js';
import { renderTemplate, slugify } from '../templates/render.js';
import { resolveTemplate } from '../templates/resolve.js';
import { BUILTIN_TYPES, ExitCode, ThoughtsError, type Finding, type SourceRef, type TemplateVars } from '../types.js';
import { SecretRefusedError, assertRepoIdSegment, fromBundlePath, isoDate, isoTimestamp, printWarnings, toBundlePath } from './common.js';

export interface NewOptions {
  shared?: boolean;
  repo?: string;
  user?: boolean;
  template?: string;
  set?: string[];
  from?: string;
  open?: boolean;
  printPath?: boolean;
  json?: boolean;
  brain?: string;
  now?: Date;
}

export interface NewResult {
  /** Bundle-relative path with leading slash. */
  path: string;
  absPath: string;
  kind: string;
  type: string;
  template: string;
  warnings: string[];
}

/** Keys that would reach Object.prototype through a plain object (SEC-F8). */
const FORBIDDEN_SET_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

export function parseSetValues(values: string[] | undefined): Record<string, string> {
  // A null-prototype object: even a bad key can never touch Object.prototype.
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const raw of values ?? []) {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new ThoughtsError(`invalid --set value "${raw}"`, ExitCode.Validation, { hint: 'use --set key=value' });
    }
    const key = raw.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) || FORBIDDEN_SET_KEYS.includes(key)) {
      throw new ThoughtsError(`invalid --set key "${key}"`, ExitCode.Validation, { hint: 'keys are letters, digits, _ . -' });
    }
    result[key] = raw.slice(eq + 1);
  }
  return result;
}

/** Escape a value for use inside a YAML double-quoted scalar. */
export function yamlDoubleQuoteEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
}

/** Variables actually referenced by the rendered template are unknown to us before rendering; report unused --set keys. */
function unusedSetKeys(set: Record<string, string>, templateContent: string): string[] {
  return Object.keys(set).filter((k) => !new RegExp(`\\{\\{[^}]*\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^}]*\\}\\}`).test(templateContent));
}

function pickFilename(dir: string, base: string): string {
  let candidate = base + '.md';
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n += 1) {
    candidate = `${base}-${n}.md`;
  }
  return candidate;
}

/** Resolve `--from` (bundle path, brain-relative path, or filesystem path) to a bundle path. */
function resolveFromPath(from: string, brainRoot: string, cwd: string): string {
  const candidates: string[] = [];
  const stripped = from.replace(/^\/+/, '');
  if (/^(shared|repos|users)\//.test(stripped)) candidates.push(fromBundlePath(brainRoot, stripped));
  candidates.push(path.resolve(cwd, from));
  for (const abs of candidates) {
    if (!fs.existsSync(abs)) continue;
    let real: string;
    let realRoot: string;
    try {
      real = fs.realpathSync(abs);
      realRoot = fs.realpathSync(brainRoot);
    } catch {
      continue;
    }
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ThoughtsError(`--from path is outside the brain: ${from}`, ExitCode.Validation);
    }
    return toBundlePath(realRoot, real);
  }
  throw new ThoughtsError(`--from path not found: ${from}`, ExitCode.Validation, {
    hint: 'give a bundle-relative path such as repos/<id>/plans/<file>.md',
  });
}

async function openInEditor(absPath: string): Promise<void> {
  const editor = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (!editor) {
    out.debug('--open: neither $VISUAL nor $EDITOR is set');
    return;
  }
  const [cmd, ...args] = editor.split(/\s+/);
  if (!cmd) return;
  await new Promise<void>((resolve) => {
    const child = spawn(cmd, [...args, absPath], { stdio: 'inherit' });
    child.on('error', (err) => {
      out.warn(`could not open editor "${editor}": ${err.message}`);
      resolve();
    });
    child.on('exit', () => resolve());
  });
}

function refuse(findings: Finding[], verb: string): never {
  throw new SecretRefusedError(findings, verb);
}

/**
 * Map a CLI kind argument to a key of `brain.kinds`: exact key, then the kind
 * whose template has that name, then `<arg>s` (spec → specs, plan → plans).
 */
export function resolveKind(kinds: Record<string, { template: string }>, arg: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(kinds, arg)) return arg;
  const byTemplate = Object.keys(kinds).find((k) => kinds[k]!.template === arg);
  if (byTemplate) return byTemplate;
  if (Object.prototype.hasOwnProperty.call(kinds, arg + 's')) return arg + 's';
  return undefined;
}

export async function runNew(kindArg: string, titleArg: string | undefined, opts: NewOptions, cwd: string): Promise<NewResult> {
  const now = opts.now ?? new Date();
  const warnings: string[] = [];
  const warn = (m: string): void => {
    warnings.push(m);
    out.warn(m);
  };
  if ((typeof titleArg !== 'string' || titleArg.trim().length === 0) && !opts.from) {
    throw new ThoughtsError('a title is required', ExitCode.Validation, { hint: 'thoughts new <kind> "<title>"' });
  }
  const set = parseSetValues(opts.set);

  const ctx = await preflight(cwd, { command: 'new', brain: opts.brain, cliVersion: cliVersion() });
  printWarnings(ctx);
  if (!ctx.brainRoot) {
    throw new ThoughtsError('no brain found', ExitCode.Validation, {
      hint: 'run inside an initialised repo or a brain clone, or pass --brain <id>',
    });
  }
  const brainRoot = ctx.brainRoot;
  const brain = ctx.brainConfig ?? (await loadBrainConfig(brainRoot));

  // Kind and template. `brain.kinds` is keyed by directory name (`specs`);
  // the CLI accepts that key, the singular template name (`spec`), or the
  // key without a trailing `s`.
  const resolvedKind = resolveKind(brain.kinds, kindArg);
  if (!resolvedKind) {
    throw new ThoughtsError(`unknown kind "${kindArg}"`, ExitCode.Validation, {
      hint: 'kinds in this brain: ' + Object.keys(brain.kinds).join(', '),
    });
  }
  const kind = resolvedKind;
  // The kind is a key of brain.yml `kinds`; it still becomes a path segment (SEC-F1).
  assertRepoIdSegment(kind, 'kind');
  const kindCfg = brain.kinds[kind]!;
  const templateName = kindCfg.template;
  const type =
    BUILTIN_TYPES[templateName] ??
    (typeof kindCfg['type'] === 'string' ? (kindCfg['type'] as string) : templateName.charAt(0).toUpperCase() + templateName.slice(1));

  // Zone.
  const zoneFlags = [opts.shared, opts.user, opts.repo !== undefined].filter(Boolean).length;
  if (zoneFlags > 1) {
    throw new ThoughtsError('--shared, --user and --repo are mutually exclusive', ExitCode.Validation);
  }
  const userId = await defaultUserId(ctx.global);
  let zoneDir: string;
  let repoField: string;
  if (opts.shared) {
    zoneDir = `/shared/${kind}`;
    repoField = 'shared';
  } else if (opts.user) {
    assertRepoIdSegment(userId, 'user id');
    zoneDir = `/users/${userId}/${kind}`;
    repoField = `user:${userId}`;
  } else {
    const repoId = opts.repo ?? ctx.repoConfig?.repo_id;
    if (!repoId) {
      throw new ThoughtsError('not inside a repo attached to this brain', ExitCode.Validation, {
        hint: 'pass --repo <id> or --shared',
      });
    }
    // SEC-F1: `--repo ../x` or a tampered `.thoughts.yml` must never leave repos/.
    assertRepoIdSegment(repoId, opts.repo !== undefined ? '--repo' : 'repo_id in .thoughts.yml');
    zoneDir = `/repos/${repoId}/${kind}`;
    repoField = repoId;
  }

  // Secrets in --set values, before anything else is rendered.
  for (const [key, value] of Object.entries(set)) {
    const findings = scanText(value, '--set ' + key);
    if (hasBlocking(findings)) refuse(findings, 'create file');
    for (const f of findings) warn(`--set ${key}: possible secret (${f.kind}) ${f.masked}`);
  }

  // `--from`: resolved before the variables so it can supply a missing title.
  let fromPath: string | undefined;
  let fromTitle: string | undefined;
  let fromFrontmatter: Record<string, unknown> | undefined;
  if (opts.from) {
    fromPath = resolveFromPath(opts.from, brainRoot, cwd);
    const text = fs.readFileSync(fromBundlePath(brainRoot, fromPath), 'utf8');
    const parsed = parseFrontmatter(text);
    if (parsed.error) warn(`--from ${fromPath}: frontmatter not parsed (${parsed.error})`);
    fromTitle = typeof parsed.frontmatter.title === 'string' ? parsed.frontmatter.title : undefined;
    fromFrontmatter = parsed.frontmatter;
  }
  const title = titleArg && titleArg.trim().length > 0 ? titleArg : fromTitle;
  if (!title) {
    throw new ThoughtsError('a title is required (the --from thought has none)', ExitCode.Validation, {
      hint: 'thoughts new <kind> "<title>" --from <path>',
    });
  }

  // Template variables (specs/06 table).
  const date = isoDate(now);
  const slug = slugify(title);
  const vars: TemplateVars = {
    title: yamlDoubleQuoteEscape(title),
    slug,
    date,
    now: isoTimestamp(now),
    kind,
    type,
    repo_id: repoField,
    brain_name: brain.name,
    author: set['author'] ?? `human:${userId}`,
  };
  if (ctx.mode === 'repo' && ctx.repoRoot) {
    const branch = await git.currentBranch(ctx.repoRoot);
    if (branch) vars.branch = branch;
    if (await git.hasHead(ctx.repoRoot)) vars.commit = await git.headSha(ctx.repoRoot);
  }
  for (const [k, v] of Object.entries(set)) if (k !== 'author') vars[k] = v;

  if (fromPath && fromFrontmatter) vars.from = { ...fromFrontmatter, path: fromPath };

  // Resolve + render.
  const resolveOpts: Parameters<typeof resolveTemplate>[1] = { brainRoot, brain, cwd };
  if (opts.template !== undefined) resolveOpts.override = opts.template;
  const tpl = await resolveTemplate(templateName, resolveOpts);
  const { output, missingVars } = renderTemplate(tpl.content, vars, { templatePath: tpl.path, now });
  const optional = new Set(['ticket', 'pr', 'branch', 'commit', 'from']);
  const reportMissing = missingVars.filter((v) => !optional.has(v.split('.')[0]!));
  if (reportMissing.length > 0) warn(`${tpl.path}: unknown variable${reportMissing.length === 1 ? '' : 's'} ${reportMissing.join(', ')} rendered empty`);
  for (const k of unusedSetKeys(set, tpl.content)) if (k !== 'author') warn(`--set ${k} is not used by template ${path.basename(tpl.path)}`);

  // Destination.
  const dirAbs = fromBundlePath(brainRoot, zoneDir);
  const filename = pickFilename(dirAbs, `${date}-${slug}`);
  const bundlePath = `${zoneDir}/${filename}`;
  const absPath = path.join(dirAbs, filename);
  if (!locate(bundlePath)) throw new ThoughtsError(`invalid destination ${bundlePath}`, ExitCode.Validation);
  // Last-line guard (SEC-F1): whatever the ids were, the file stays inside the brain.
  if (!path.resolve(absPath).startsWith(path.resolve(brainRoot) + path.sep)) {
    throw new ThoughtsError(`destination ${bundlePath} is outside the brain`, ExitCode.Validation, {
      hint: 'repo, user and kind ids are single path segments: letters, digits, . _ -',
    });
  }

  // Post-process the rendered frontmatter for --from (preserving unknown keys).
  let content = output;
  const rendered = parseFrontmatter(output);
  if (rendered.error || !rendered.hasFrontmatter) {
    warn(`${tpl.path}: rendered frontmatter is not valid YAML${rendered.error ? ' (' + rendered.error + ')' : ''}`);
  } else if (fromPath) {
    const fm = rendered.frontmatter;
    const sources: SourceRef[] = Array.isArray(fm.sources) ? [...fm.sources] : [];
    const ref: SourceRef = { resource: fromPath };
    if (fromTitle) ref.title = fromTitle;
    if (!sources.some((s) => s.resource === fromPath)) sources.push(ref);
    fm.sources = sources;
    content = serializeThought(fm, rendered.body);
  }
  if (!content.endsWith('\n')) content += '\n';

  // Scan the rendered file, then write.
  const findings = scanText(content, bundlePath);
  if (hasBlocking(findings)) refuse(findings, 'create file');
  for (const f of findings) warn(`${bundlePath}:${f.line}: possible secret (${f.kind}) ${f.masked}`);
  fs.mkdirSync(dirAbs, { recursive: true });
  fs.writeFileSync(absPath, content, { flag: 'wx' });

  const result: NewResult = { path: bundlePath, absPath, kind, type, template: templateName, warnings };
  if (opts.json) {
    out.print(JSON.stringify({ path: bundlePath, absPath, kind, type, template: templateName }));
  } else {
    out.print(bundlePath);
  }
  if (opts.open && !opts.printPath) await openInEditor(absPath);
  return result;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function register(program: Command): void {
  program
    .command('new')
    .description('Create a thought from a template in the right zone')
    .argument('<kind>', 'kind, e.g. spec, plan, research, decision, pr')
    .argument('[title]', 'title of the thought (defaults to the --from thought\'s title)')
    .option('--shared', 'create under shared/ instead of this repo')
    .option('--repo <id>', 'create under repos/<id>/')
    .option('--user', 'create under users/<me>/')
    .option('--template <path>', 'template file to use instead of the configured source')
    .option('--set <key=value>', 'template variable (repeatable)', collect, [])
    .option('--from <path>', 'link an existing thought as a source')
    .option('--open', 'open the file in $VISUAL / $EDITOR')
    .option('--print-path', 'only print the path (default behaviour)')
    .option('--json', 'print {path, absPath, kind, type, template} as JSON')
    .option('--brain <id|url>', 'brain to use when outside a repo')
    .action(async (kind: string, title: string | undefined, opts: NewOptions) => {
      await runNew(kind, title, opts, process.cwd());
    });
}
