/**
 * Language support for the codebase graph (specs/17 "How it is built").
 *
 * Parsing uses web-tree-sitter (WASM); grammars ship as the
 * `tree-sitter-wasms` optional dependency. Both are optional: a missing or
 * broken install is a catchable rejection, never a crash — the caller (sync,
 * init, status) degrades to "no graph" with exactly one warning.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Language, Parser } from 'web-tree-sitter';

export type { Language, Parser };

/** Languages with a grammar in v1 (specs/17). Everything else is a bare file node. */
export type CodeLanguage = 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'go' | 'rs';

export const CODE_LANGUAGES: readonly CodeLanguage[] = ['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs'];

/** Repo-relative extension (with dot) → language. */
const EXTENSIONS: Record<string, CodeLanguage> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.jsx': 'jsx',
  '.py': 'py',
  '.go': 'go',
  '.rs': 'rs',
};

/** The grammar wasm shipped by `tree-sitter-wasms` for each language. */
const GRAMMAR_WASM: Record<CodeLanguage, string> = {
  ts: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  js: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  py: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rs: 'tree-sitter-rust.wasm',
};

/** Language for a repo-relative path, or undefined when v1 has no grammar for it. */
export function languageForPath(relPath: string): CodeLanguage | undefined {
  return EXTENSIONS[path.posix.extname(relPath).toLowerCase()];
}

/**
 * Everything below fails soft: any failure resolves to an Error rejection the
 * caller catches (specs/17 "Fail soft, exactly one warning"). Nothing here
 * throws synchronously out of an exported function.
 */

let initOnce: Promise<void> | undefined;
const languageCache = new Map<CodeLanguage, Promise<Language>>();
const parserCache = new Map<CodeLanguage, Promise<Parser>>();

/**
 * The runtime module, imported lazily: `web-tree-sitter` is an
 * optionalDependency, so a static import would crash every command at module
 * load when the install failed (specs/17: "a failed install is not an install
 * failure"). A dynamic import keeps the failure catchable, and the caller
 * degrades to "no graph" with exactly one warning.
 */
let runtime: typeof import('web-tree-sitter') | undefined;

async function initRuntime(): Promise<void> {
  if (!initOnce) {
    initOnce = (async () => {
      try {
        runtime = await import('web-tree-sitter');
        await runtime.Parser.init();
      } catch (err) {
        runtime = undefined;
        throw new Error(`codegraph: web-tree-sitter runtime failed to load: ${messageOf(err)}`, { cause: err });
      }
    })();
  }
  return initOnce;
}

/** The loaded runtime module; only valid after initRuntime() resolved. */
function runtimeParser(): typeof Parser {
  if (!runtime) throw new Error('codegraph: web-tree-sitter runtime is not loaded');
  return runtime.Parser;
}

function resolveGrammar(lang: CodeLanguage): string {
  const file = GRAMMAR_WASM[lang];
  try {
    const req = createRequire(import.meta.url);
    return req.resolve('tree-sitter-wasms/out/' + file);
  } catch (err) {
    throw new Error(
      `codegraph: grammar for ${lang} is unavailable (the tree-sitter-wasms optional dependency is not installed)`,
      { cause: err },
    );
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Grammar for one language, loaded once per process. Rejections are catchable. */
export function loadLanguage(lang: CodeLanguage): Promise<Language> {
  let cached = languageCache.get(lang);
  if (!cached) {
    cached = (async () => {
      await initRuntime();
      const wasm = resolveGrammar(lang);
      try {
        return await runtime!.Language.load(wasm);
      } catch (err) {
        throw new Error(`codegraph: grammar for ${lang} failed to load (${messageOf(err)})`, { cause: err });
      }
    })();
    // A failed load is not retried forever, but it must not poison the cache
    // for a later call either: drop it so the next call tries again.
    cached.catch(() => languageCache.delete(lang));
    languageCache.set(lang, cached);
  }
  return cached;
}

/**
 * A parser per language, cached for the process (specs/17: grammars ship as
 * optionalDependencies; a failed load surfaces as a catchable rejection).
 */
export function getParser(lang: CodeLanguage): Promise<Parser> {
  let cached = parserCache.get(lang);
  if (!cached) {
    cached = (async () => {
      const language = await loadLanguage(lang);
      const parser = new (runtimeParser())();
      parser.setLanguage(language);
      return parser;
    })();
    cached.catch(() => parserCache.delete(lang));
    parserCache.set(lang, cached);
  }
  return cached;
}

/** Free the cached parsers (used by tests to prove a cold start fails soft). */
export function releaseParsers(): void {
  for (const p of parserCache.values()) {
    void p.then((parser) => {
      try {
        parser.delete();
      } catch {
        // already gone
      }
    });
  }
  parserCache.clear();
  languageCache.clear();
}
