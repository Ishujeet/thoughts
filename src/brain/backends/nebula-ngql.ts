/**
 * The nGQL text layer of the nebula backend (specs/16 "Backend kinds": the
 * transport is "nGQL statements"): literal escaping, parameter substitution and
 * the statement op tag. Kept in its own module so the fake client in the tests
 * can share the exact escaping without importing the transport.
 */
import { ExitCode, ThoughtsError } from '../../types.js';

/** The op tag of a statement: its leading `# thoughts:<op>` comment. */
export function opOf(stmt: string): string {
  return /^#\s*thoughts:([a-z0-9_]+)/m.exec(stmt)?.[1] ?? 'unknown';
}

/** Prefix a statement with its op tag. */
export function tagged(op: string, body: string): string {
  return `# thoughts:${op}\n${body}`;
}

/**
 * One nGQL literal: strings in single quotes with backslash, quote and
 * control characters escaped; numbers and booleans bare; null as NULL. This is
 * the only place value escaping lives — every write statement is built
 * through it, so a quote or newline inside a thought body can never break out
 * of the statement.
 */
export function nqLit(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const s = String(value);
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return `'${out}'`;
}

/**
 * Quote an identifier (space / tag / edge / property name) for nGQL. Plain
 * identifiers pass through bare, so existing statements are byte-identical;
 * anything else is backtick-quoted with embedded backticks doubled.
 */
export function nqId(name: string): string {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replaceAll('`', '``')}\``;
}

/**
 * Fill a statement's `$name` placeholders from `params`. `$-` (pipe results)
 * and `$^` (referential) are nGQL syntax, not parameters, and pass through.
 * A placeholder with no parameter is a bug in the statement builder: it is
 * refused here rather than sent to the server half-built.
 */
export function substituteParams(stmt: string, params: Record<string, unknown> | undefined): string {
  if (params === undefined) return stmt;
  return stmt.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => {
    if (!(name in params)) {
      throw new ThoughtsError(`nebula statement references an unfilled parameter "$${name}"`, ExitCode.Validation);
    }
    return nqLit(params[name]);
  });
}
