/**
 * Per-file extraction (specs/17 "RepoGraph schema"). Pure functions over
 * source text: given a path, a language and the source, they return the
 * symbols, imports and call edges derivable from the syntax tree.
 *
 * Deliberately conservative in v1 (specs/17 "Open questions"):
 * - top-level declarations plus one nesting level (class methods),
 * - `calls` resolve intra-file only, and only through a bare callee name,
 * - relative imports stay unresolved here; `graph.ts` resolves them against
 *   the set of file nodes the repo actually has.
 */
import { createHash } from 'node:crypto';
import { getParser, type CodeLanguage, type Parser } from './languages.js';

export type SymbolKind = 'function' | 'class' | 'method' | 'type' | 'const';

export interface ExtractedSymbol {
  /** Qualified name inside the file: `greet`, `Widget.render`. */
  name: string;
  kind: SymbolKind;
  /** 1-based line range in the file. */
  line: number;
  endLine: number;
}

/** An import as written: `kind` says whether it can resolve to a repo file. */
export interface ExtractedImport {
  spec: string;
  kind: 'relative' | 'bare';
}

/** A call edge resolved inside the file: both ends are qualified names. */
export interface ExtractedCall {
  caller: string;
  callee: string;
}

export interface FileExtraction {
  /** Repo-relative path, posix separators. */
  path: string;
  language: CodeLanguage;
  /** sha256 of the source text (specs/17: file nodes carry a content sha). */
  sha: string;
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  /** Bare package names imported — the candidates for module nodes. */
  modules: string[];
  calls: ExtractedCall[];
}

/** Extracting a huge file is not worth the parse: it stays a bare file node. */
const MAX_EXTRACT_BYTES = 1024 * 1024;

export function shaOf(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

/** The package name of a bare import specifier (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageNameOf(spec: string): string {
  if (spec.startsWith('@')) {
    const parts = spec.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split('/')[0] ?? '';
}

/** Python: the package is the first segment of a dotted module path. */
export function pyPackageName(spec: string): string {
  return spec.split('.')[0] ?? '';
}

// The walkers only need a structural view of tree-sitter nodes; this narrow
// structural type keeps the runtime type out of the graph schema.
interface SyntaxNode {
  readonly type: string;
  readonly text: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly startPosition: { row: number; column: number };
  readonly endPosition: { row: number; column: number };
  readonly namedChildCount: number;
  namedChild(index: number): SyntaxNode | null;
}

interface RawSymbol {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  /** 0-based byte offsets, used to attribute a call to its innermost symbol. */
  start: number;
  end: number;
}

function namedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i += 1) {
    const c = node.namedChild(i);
    if (c) out.push(c);
  }
  return out;
}

function childOfTypes(node: SyntaxNode, types: readonly string[]): SyntaxNode | null {
  for (const c of namedChildren(node)) if (types.includes(c.type)) return c;
  return null;
}

function firstIdentifier(node: SyntaxNode, types: readonly string[] = ['identifier', 'type_identifier', 'property_identifier', 'field_identifier']): string | null {
  const c = childOfTypes(node, types);
  return c ? c.text : null;
}

function spanOf(node: SyntaxNode): { line: number; endLine: number; start: number; end: number } {
  return {
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    start: node.startIndex,
    end: node.endIndex,
  };
}

/** Walk every node of the subtree, depth-first, in source order. */
function visit(node: SyntaxNode, fn: (node: SyntaxNode) => void): void {
  fn(node);
  for (const c of namedChildren(node)) visit(c, fn);
}

/** True for specifiers that never name a repo-external package (`node:fs`). */
export function isBuiltinSpec(spec: string): boolean {
  return spec.startsWith('node:');
}

function addModule(out: FileExtraction, pkg: string): void {
  if (pkg.length === 0 || isBuiltinSpec(pkg)) return;
  if (!out.modules.includes(pkg)) out.modules.push(pkg);
}

/** Record a bare import and its package (builtins are imports, not modules). */
function addBare(out: FileExtraction, spec: string): void {
  if (spec.length === 0) return;
  out.imports.push({ spec, kind: 'bare' });
  addModule(out, packageNameOf(spec));
}

function addRelative(out: FileExtraction, spec: string): void {
  if (spec.length === 0) return;
  out.imports.push({ spec, kind: 'relative' });
}

function finish(symbols: RawSymbol[], bare: { name: string; start: number }[], out: FileExtraction): void {
  out.symbols = symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line, endLine: s.endLine }));
  resolveCalls(bare, symbols, out);
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript / TSX / JSX
// ---------------------------------------------------------------------------

const TS_TOP = [
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
] as const;

function extractTs(root: SyntaxNode, out: FileExtraction): void {
  const symbols: RawSymbol[] = [];

  const declare = (node: SyntaxNode): void => {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = firstIdentifier(node, ['identifier']);
        if (name) symbols.push({ name, kind: 'function', ...spanOf(node) });
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = firstIdentifier(node, ['type_identifier', 'identifier']);
        if (!name) return;
        symbols.push({ name, kind: 'class', ...spanOf(node) });
        const body = childOfTypes(node, ['class_body']);
        if (!body) return;
        for (const member of namedChildren(body)) {
          if (member.type !== 'method_definition' && member.type !== 'abstract_method_definition') continue;
          const m = firstIdentifier(member, ['property_identifier']);
          if (m) symbols.push({ name: `${name}.${m}`, kind: 'method', ...spanOf(member) });
        }
        return;
      }
      case 'interface_declaration':
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const name = firstIdentifier(node, ['type_identifier']);
        if (name) symbols.push({ name, kind: 'type', ...spanOf(node) });
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of namedChildren(node)) {
          if (d.type !== 'variable_declarator') continue;
          const name = firstIdentifier(d, ['identifier']);
          if (name) symbols.push({ name, kind: 'const', ...spanOf(node) });
        }
        return;
      }
      default:
        return;
    }
  };

  const importSpec = (spec: string): void => {
    if (spec.startsWith('.')) addRelative(out, spec);
    else addBare(out, spec);
  };

  for (const node of namedChildren(root)) {
    if (node.type === 'export_statement') {
      const inner = childOfTypes(node, TS_TOP);
      if (inner) {
        declare(inner);
        continue;
      }
      const source = childOfTypes(node, ['string']);
      const spec = source ? (childOfTypes(source, ['string_fragment'])?.text ?? '') : '';
      if (spec) importSpec(spec); // `export … from '…'`
      continue;
    }
    if (node.type === 'import_statement') {
      const source = childOfTypes(node, ['string']);
      const spec = source ? (childOfTypes(source, ['string_fragment'])?.text ?? '') : '';
      if (spec) importSpec(spec);
      continue;
    }
    declare(node);
  }

  // `require('x')` and `await import('x')` can sit at any depth.
  visit(root, (n) => {
    if (n.type !== 'call_expression') return;
    const fn = n.namedChild(0);
    if (!fn) return;
    const args = n.namedChild(1);
    const str = args && args.type === 'arguments' ? childOfTypes(args, ['string']) : args && args.type === 'string' ? args : null;
    const spec = str ? (childOfTypes(str, ['string_fragment'])?.text ?? '') : '';
    if (spec && (fn.text === 'require' || fn.type === 'import')) importSpec(spec);
  });

  const bareCalls: BareCall[] = [];
  visit(root, (n) => {
    if (n.type !== 'call_expression') return;
    const fn = n.namedChild(0);
    if (fn && fn.type === 'identifier') bareCalls.push({ name: fn.text, start: n.startIndex });
  });
  finish(symbols, bareCalls, out);
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function extractPy(root: SyntaxNode, out: FileExtraction): void {
  const symbols: RawSymbol[] = [];

  const declareFn = (node: SyntaxNode, prefix: string): void => {
    const name = firstIdentifier(node, ['identifier']);
    if (!name) return;
    symbols.push({ name: prefix + name, kind: prefix ? 'method' : 'function', ...spanOf(node) });
  };

  const declareClass = (node: SyntaxNode): void => {
    const name = firstIdentifier(node, ['identifier']);
    if (!name) return;
    symbols.push({ name, kind: 'class', ...spanOf(node) });
    const body = childOfTypes(node, ['block']);
    if (!body) return;
    for (const member of namedChildren(body)) {
      const fn = member.type === 'function_definition' ? member : member.type === 'decorated_definition' ? childOfTypes(member, ['function_definition']) : null;
      if (fn) declareFn(fn, name + '.');
    }
  };

  for (const node of namedChildren(root)) {
    if (node.type === 'function_definition') declareFn(node, '');
    else if (node.type === 'class_definition') declareClass(node);
    else if (node.type === 'decorated_definition') {
      const inner = childOfTypes(node, ['function_definition', 'class_definition']);
      if (inner?.type === 'function_definition') declareFn(inner, '');
      else if (inner) declareClass(inner);
    } else if (node.type === 'import_statement') {
      for (const d of namedChildren(node)) {
        const target = d.type === 'aliased_import' ? d.namedChild(0) : d;
        if (target && (target.type === 'dotted_name' || target.type === 'identifier')) addBare(out, pyPackageName(target.text));
      }
    } else if (node.type === 'import_from_statement') {
      const module = node.namedChild(0);
      if (!module) continue;
      if (module.type === 'relative_import') addRelative(out, module.text);
      else if (module.type === 'dotted_name' || module.type === 'identifier') addBare(out, pyPackageName(module.text));
    } else if (node.type === 'expression_statement') {
      const assign = childOfTypes(node, ['assignment']);
      const name = assign ? firstIdentifier(assign, ['identifier']) : null;
      if (name) symbols.push({ name, kind: 'const', ...spanOf(node) });
    }
  }

  const bareCalls: BareCall[] = [];
  visit(root, (n) => {
    if (n.type !== 'call') return;
    const fn = n.namedChild(0);
    if (fn && fn.type === 'identifier') bareCalls.push({ name: fn.text, start: n.startIndex });
  });
  finish(symbols, bareCalls, out);
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function extractGo(root: SyntaxNode, out: FileExtraction): void {
  const symbols: RawSymbol[] = [];

  for (const node of namedChildren(root)) {
    if (node.type === 'function_declaration') {
      const name = firstIdentifier(node, ['identifier']);
      if (name) symbols.push({ name, kind: 'function', ...spanOf(node) });
    } else if (node.type === 'method_declaration') {
      const name = firstIdentifier(node, ['field_identifier']);
      if (!name) continue;
      const receiver = childOfTypes(node, ['parameter_list']);
      const recv = receiver ? firstIdentifier(receiver, ['type_identifier']) : null;
      symbols.push({ name: recv ? `${recv}.${name}` : name, kind: 'method', ...spanOf(node) });
    } else if (node.type === 'type_declaration') {
      for (const spec of namedChildren(node)) {
        if (spec.type !== 'type_spec') continue;
        const name = firstIdentifier(spec, ['type_identifier']);
        if (name) symbols.push({ name, kind: 'type', ...spanOf(spec) });
      }
    } else if (node.type === 'const_declaration' || node.type === 'var_declaration') {
      for (const spec of namedChildren(node)) {
        if (spec.type !== 'const_spec' && spec.type !== 'var_spec') continue;
        for (const id of namedChildren(spec)) {
          if (id.type === 'identifier') symbols.push({ name: id.text, kind: 'const', ...spanOf(spec) });
        }
      }
    } else if (node.type === 'import_declaration') {
      for (const spec of namedChildren(node)) {
        const literal = spec.type === 'import_spec' ? childOfTypes(spec, ['interpreted_string_literal', 'raw_string_literal']) : spec;
        if (!literal || (literal.type !== 'interpreted_string_literal' && literal.type !== 'raw_string_literal')) continue;
        const target = literal.text.replace(/^["'`]|["'`]$/g, '');
        if (target.length === 0) continue;
        if (target.startsWith('.') || target.startsWith('/')) addRelative(out, target);
        else addBare(out, target);
      }
    }
  }

  const bareCalls: BareCall[] = [];
  visit(root, (n) => {
    if (n.type !== 'call_expression') return;
    const fn = n.namedChild(0);
    if (fn && fn.type === 'identifier') bareCalls.push({ name: fn.text, start: n.startIndex });
  });
  finish(symbols, bareCalls, out);
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

function extractRs(root: SyntaxNode, out: FileExtraction): void {
  const symbols: RawSymbol[] = [];

  const declareItem = (node: SyntaxNode, prefix: string): void => {
    switch (node.type) {
      case 'function_item': {
        const name = firstIdentifier(node, ['identifier']);
        if (name) symbols.push({ name: prefix + name, kind: prefix ? 'method' : 'function', ...spanOf(node) });
        return;
      }
      case 'struct_item':
      case 'enum_item':
      case 'trait_item':
      case 'type_item': {
        const name = firstIdentifier(node, ['type_identifier']);
        if (name) symbols.push({ name: prefix + name, kind: 'type', ...spanOf(node) });
        return;
      }
      case 'const_item':
      case 'static_item': {
        const name = firstIdentifier(node, ['identifier']);
        if (name) symbols.push({ name: prefix + name, kind: 'const', ...spanOf(node) });
        return;
      }
      case 'impl_item': {
        const type = firstIdentifier(node, ['type_identifier']);
        const list = childOfTypes(node, ['declaration_list']);
        if (!type || !list) return;
        for (const item of namedChildren(list)) declareItem(item, type + '.');
        return;
      }
      default:
        return;
    }
  };

  for (const node of namedChildren(root)) {
    if (node.type === 'use_declaration') {
      const arg = node.namedChild(0);
      const first = (arg ? arg.text : '').split('::')[0] ?? '';
      if (first.length === 0 || first === 'crate' || first === 'self' || first === 'super') continue;
      addBare(out, first);
      continue;
    }
    declareItem(node, '');
  }

  const bareCalls: BareCall[] = [];
  visit(root, (n) => {
    if (n.type !== 'call_expression') return;
    const fn = n.namedChild(0);
    if (fn && fn.type === 'identifier') bareCalls.push({ name: fn.text, start: n.startIndex });
  });
  finish(symbols, bareCalls, out);
}

// ---------------------------------------------------------------------------
// Call resolution (intra-file, bare callee names only — specs/17)
// ---------------------------------------------------------------------------

interface BareCall {
  name: string;
  start: number;
}

/** Resolve bare calls against the file's own symbols; innermost caller wins. */
function resolveCalls(bare: BareCall[], symbols: RawSymbol[], out: FileExtraction): void {
  if (bare.length === 0 || symbols.length === 0) return;
  const byName = new Map<string, RawSymbol[]>();
  for (const s of symbols) {
    const keys = new Set([s.name]);
    if (s.name.includes('.')) keys.add(s.name.split('.').pop() ?? '');
    for (const key of keys) {
      const list = byName.get(key) ?? [];
      list.push(s);
      byName.set(key, list);
    }
  }
  for (const list of byName.values()) list.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const seen = new Set<string>();
  for (const call of bare) {
    const candidates = byName.get(call.name);
    if (!candidates || candidates.length === 0) continue;
    const caller = innermostSymbol(symbols, call.start);
    if (!caller) continue;
    const callee = candidates[0]!;
    if (caller.name === callee.name) continue; // self-recursion is not an edge
    const key = `${caller.name}→${callee.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.calls.push({ caller: caller.name, callee: callee.name });
  }
}

function innermostSymbol(symbols: RawSymbol[], offset: number): RawSymbol | undefined {
  let best: RawSymbol | undefined;
  for (const s of symbols) {
    if (offset < s.start || offset > s.end) continue;
    if (!best || s.end - s.start <= best.end - best.start) best = s;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Extract one file. Rejects when the grammar for `lang` cannot load or the
 * parse produces nothing; callers treat any failure as a codegraph step
 * failure for the whole repo (specs/17 "Fail soft, exactly one warning").
 */
export async function extractFile(relPath: string, lang: CodeLanguage, source: string): Promise<FileExtraction> {
  const out: FileExtraction = {
    path: relPath.split('\\').join('/'),
    language: lang,
    sha: shaOf(source),
    symbols: [],
    imports: [],
    modules: [],
    calls: [],
  };
  if (source.length > MAX_EXTRACT_BYTES) return out;
  const parser = await getParser(lang);
  let tree: ReturnType<Parser['parse']> = null;
  try {
    tree = parser.parse(source);
  } catch (err) {
    throw new Error(`codegraph: parsing ${relPath} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!tree || tree.rootNode === null) {
    throw new Error(`codegraph: parsing ${relPath} produced no tree`);
  }
  const root = tree.rootNode as unknown as SyntaxNode;
  switch (lang) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      extractTs(root, out);
      break;
    case 'py':
      extractPy(root, out);
      break;
    case 'go':
      extractGo(root, out);
      break;
    case 'rs':
      extractRs(root, out);
      break;
  }
  return out;
}
