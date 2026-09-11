/**
 * Restricted Handlebars renderer (specs/07 "Template syntax", D2, D13).
 *
 * Allowed: `{{var}}`, `{{object.field}}`, `{{#if}}…{{else}}…{{/if}}`,
 * `{{#each}}…{{/each}}`, and the helpers in ALLOWED_HELPERS. Everything else
 * (partials, decorators, raw blocks, unknown helpers, sub-expressions) is
 * rejected before compilation with a message naming the template and line.
 *
 * HTML escaping is off (markdown output). Unknown variables render empty and
 * are reported in `missingVars` so the caller can warn.
 */
import Handlebars from 'handlebars';
import { ALLOWED_HELPERS, ExitCode, ThoughtsError } from '../types.js';

export interface RenderOptions {
  /** Display name of the template (file path) for error messages. */
  templatePath: string;
  /** Used by the `date` helper when called without arguments and no `date` var exists. */
  now?: Date;
}

export interface RenderResult {
  output: string;
  /** Dotted variable paths referenced by the template that are not present in `vars`. */
  missingVars: string[];
}

const ALLOWED_BLOCKS = new Set(['if', 'each']);
const ALLOWED = new Set(ALLOWED_HELPERS);

type AnyNode = hbs.AST.Node & Record<string, unknown>;

function line(node: hbs.AST.Node | undefined): number | undefined {
  return node?.loc?.start?.line;
}

function reject(templatePath: string, node: hbs.AST.Node | undefined, what: string): never {
  const ln = line(node);
  throw new ThoughtsError(`${templatePath}${ln !== undefined ? ':' + ln : ''}: ${what}`, ExitCode.Validation, {
    hint: 'templates may only use {{var}}, {{#if}}, {{#each}} and the helpers ' + ALLOWED_HELPERS.join(', '),
  });
}

/** Slug rule shared with `thoughts new` (specs/06): lowercase, [a-z0-9-], collapsed dashes, max 60. */
export function slugify(input: string): string {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const cut = s.slice(0, 60).replace(/-$/, '');
  return cut.length > 0 ? cut : 'untitled';
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toDateString(value: unknown, fallback: Date): string {
  if (value instanceof Date) return isoDate(value);
  if (typeof value === 'string' && value.length > 0) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : isoDate(d);
  }
  return isoDate(fallback);
}

function createEngine(now: Date): typeof Handlebars {
  const hb = Handlebars.create();
  // Handlebars calls a registered helper for `{{date}}` even when a `date`
  // variable exists, so the helper falls back to the context value.
  hb.registerHelper('date', function (this: unknown, ...args: unknown[]) {
    const options = args.pop() as { data?: { root?: Record<string, unknown> } } | undefined;
    if (args.length > 0) return toDateString(args[0], now);
    const ctx = this as Record<string, unknown> | undefined;
    const root = options?.data?.root;
    const v = ctx && typeof ctx === 'object' && 'date' in ctx ? ctx['date'] : root?.['date'];
    return toDateString(v, now);
  });
  hb.registerHelper('slug', (value: unknown) => slugify(typeof value === 'string' ? value : ''));
  hb.registerHelper('upper', (value: unknown) => (value === undefined || value === null ? '' : String(value).toUpperCase()));
  hb.registerHelper('lower', (value: unknown) => (value === undefined || value === null ? '' : String(value).toLowerCase()));
  hb.registerHelper('join', (list: unknown, ...rest: unknown[]) => {
    const sep = rest.length > 1 && typeof rest[0] === 'string' ? rest[0] : ', ';
    if (!Array.isArray(list)) return list === undefined || list === null ? '' : String(list);
    return list.map((x) => String(x)).join(sep);
  });
  // No partials, ever (specs/07).
  return hb;
}

interface WalkState {
  templatePath: string;
  missing: Set<string>;
  /** Context stack, innermost last. `unknown` when the context cannot be known statically. */
  contexts: Array<{ value: unknown; known: boolean; prefix: string }>;
}

function hasPath(ctx: unknown, parts: string[]): { found: boolean; value: unknown } {
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return { found: false, value: undefined };
    if (!(p in (cur as Record<string, unknown>))) return { found: false, value: undefined };
    cur = (cur as Record<string, unknown>)[p];
  }
  return { found: true, value: cur };
}

function checkPath(state: WalkState, node: hbs.AST.PathExpression): unknown {
  if (node.data) return undefined; // @index, @key, @root …
  if (node.parts.length === 0) return state.contexts[state.contexts.length - 1]?.value; // `this`
  const idx = state.contexts.length - 1 - node.depth;
  const ctx = state.contexts[idx];
  if (!ctx) return undefined;
  if (!ctx.known) return undefined;
  const parts = node.parts[0] === 'this' ? node.parts.slice(1) : node.parts;
  const r = hasPath(ctx.value, parts);
  if (!r.found) {
    const name = (ctx.prefix ? ctx.prefix + '.' : '') + parts.join('.');
    state.missing.add(name);
  }
  return r.value;
}

function checkExpression(state: WalkState, expr: hbs.AST.Expression): unknown {
  switch (expr.type) {
    case 'PathExpression':
      return checkPath(state, expr as hbs.AST.PathExpression);
    case 'SubExpression':
      return reject(state.templatePath, expr, 'sub-expressions are not allowed');
    case 'StringLiteral':
    case 'NumberLiteral':
    case 'BooleanLiteral':
    case 'UndefinedLiteral':
    case 'NullLiteral':
      return (expr as AnyNode)['value'];
    default:
      return reject(state.templatePath, expr, `${expr.type} is not allowed`);
  }
}

function checkHash(state: WalkState, hash: hbs.AST.Hash | undefined): void {
  if (!hash) return;
  for (const pair of hash.pairs) checkExpression(state, pair.value);
}

function checkMustache(state: WalkState, node: hbs.AST.MustacheStatement): void {
  if (node.path.type !== 'PathExpression') {
    // `{{"literal"}}` — harmless but pointless; allow literals.
    return;
  }
  const p = node.path as hbs.AST.PathExpression;
  const isHelperCall = node.params.length > 0 || (node.hash && node.hash.pairs.length > 0);
  const name = p.parts.length === 1 && p.depth === 0 && !p.data ? p.parts[0]! : undefined;
  if (isHelperCall) {
    if (name === undefined || !ALLOWED.has(name)) {
      reject(state.templatePath, node, `helper "${p.original}" is not allowed`);
    }
    for (const param of node.params) checkExpression(state, param);
    checkHash(state, node.hash);
    return;
  }
  if (name === 'else') return; // `{{else}}` outside a block is a syntax error, parse catches it.
  // Plain variable. `{{date}}` is both a helper and a variable; treat as variable lookup.
  checkPath(state, p);
}

function checkBlock(state: WalkState, node: hbs.AST.BlockStatement): void {
  const p = node.path;
  const name = p.parts.length === 1 && p.depth === 0 && !p.data ? p.parts[0]! : p.original;
  if (!ALLOWED_BLOCKS.has(name)) {
    reject(state.templatePath, node, `block helper "#${p.original}" is not allowed (only #if and #each)`);
  }
  if (node.params.length !== 1) {
    reject(state.templatePath, node, `#${name} takes exactly one argument`);
  }
  if (node.hash && node.hash.pairs.length > 0) {
    reject(state.templatePath, node, `#${name} does not accept hash arguments`);
  }
  const param = node.params[0]!;
  const value = checkExpression(state, param);
  if (name === 'if') {
    walkProgram(state, node.program);
    if (node.inverse) walkProgram(state, node.inverse);
    return;
  }
  // each: body is evaluated against each element.
  const prefix = param.type === 'PathExpression' ? (param as hbs.AST.PathExpression).parts.join('.') + '[]' : '';
  if (Array.isArray(value)) {
    // Check against the first element that is an object; primitives have no fields.
    const sample = value.find((v) => v !== null && typeof v === 'object');
    state.contexts.push({ value: sample ?? {}, known: sample !== undefined, prefix });
  } else if (value !== null && typeof value === 'object') {
    const vals = Object.values(value as Record<string, unknown>);
    const sample = vals.find((v) => v !== null && typeof v === 'object');
    state.contexts.push({ value: sample ?? {}, known: sample !== undefined, prefix });
  } else {
    state.contexts.push({ value: undefined, known: false, prefix });
  }
  walkProgram(state, node.program);
  state.contexts.pop();
  if (node.inverse) walkProgram(state, node.inverse);
}

function walkProgram(state: WalkState, program: hbs.AST.Program | undefined): void {
  if (!program) return;
  for (const stmt of program.body) {
    switch (stmt.type) {
      case 'ContentStatement':
      case 'CommentStatement':
        break;
      case 'MustacheStatement':
        checkMustache(state, stmt as hbs.AST.MustacheStatement);
        break;
      case 'BlockStatement':
        checkBlock(state, stmt as hbs.AST.BlockStatement);
        break;
      case 'PartialStatement':
      case 'PartialBlockStatement':
        reject(state.templatePath, stmt, 'partials are not allowed');
        break;
      case 'Decorator':
      case 'DecoratorBlock':
        reject(state.templatePath, stmt, 'decorators are not allowed');
        break;
      default:
        reject(state.templatePath, stmt, `${stmt.type} is not allowed`);
    }
  }
}

function errorLine(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const ln = (err as { lineNumber?: unknown }).lineNumber;
    if (typeof ln === 'number') return ln;
    const m = /line (\d+)/i.exec((err as { message?: string }).message ?? '');
    if (m) return Number(m[1]);
  }
  return undefined;
}

function firstMessageLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]!.trim();
}

/**
 * Validate `content` against the allowed subset and render it with `vars`.
 * Throws ThoughtsError(Validation) as `<templatePath>:<line>: <reason>`.
 */
export function renderTemplate(content: string, vars: Record<string, unknown>, opts: RenderOptions): RenderResult {
  const now = opts.now ?? new Date();
  let ast: hbs.AST.Program;
  try {
    ast = Handlebars.parse(content);
  } catch (err) {
    const ln = errorLine(err);
    throw new ThoughtsError(`${opts.templatePath}${ln !== undefined ? ':' + ln : ''}: ${firstMessageLine(err)}`, ExitCode.Validation, {
      cause: err,
    });
  }
  const state: WalkState = {
    templatePath: opts.templatePath,
    missing: new Set(),
    contexts: [{ value: vars, known: true, prefix: '' }],
  };
  walkProgram(state, ast);

  const hb = createEngine(now);
  let output: string;
  try {
    const compiled = hb.compile(ast, {
      noEscape: true,
      strict: false,
      knownHelpers: Object.fromEntries(ALLOWED_HELPERS.map((h) => [h, true])),
      knownHelpersOnly: true,
      preventIndent: true,
    });
    output = compiled(vars);
  } catch (err) {
    const ln = errorLine(err);
    throw new ThoughtsError(`${opts.templatePath}${ln !== undefined ? ':' + ln : ''}: ${firstMessageLine(err)}`, ExitCode.Validation, {
      cause: err,
    });
  }
  return { output, missingVars: [...state.missing].sort() };
}

/** Validate only (used by `templates lint` later); throws on disallowed syntax. */
export function validateTemplateSyntax(content: string, templatePath: string): void {
  renderTemplate(content, {}, { templatePath });
}
