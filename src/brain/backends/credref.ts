/**
 * Credential references (specs/16 "Credential references", specs/10 "Common
 * contract"). Connection details NEVER live in the brain or in any committed
 * file; committed files and global config carry only a *ref*:
 *
 *   env:VAR      — an environment variable holding the connection string
 *   keyref:name  — an entry in the CLI-managed key store (`~/.config/thoughts`
 *                  `keyrefs:` until the OS-keychain integration of specs/10
 *                  lands; the ref form is already final)
 *
 * The ref itself is resolved from `~/.config/thoughts/config.yml` at connect
 * time. The resolved connection string never enters the brain, any committed
 * file, or printed output: everything a message may carry goes through
 * `maskConnectionString` first.
 */
import { ExitCode, ThoughtsError, type GlobalConfig } from '../../types.js';
import { loadGlobalConfig } from '../config.js';

/** Env var a psql brain falls back to when no connection ref is configured. */
export const DEFAULT_PG_CONNECTION_ENV = 'THOUGHTS_BRAIN_PG';

export const DEFAULT_NEBULA_CONNECTION_ENV = 'THOUGHTS_NEBULA';

export type CredRef = { scheme: 'env'; name: string } | { scheme: 'keyref'; name: string };

const CRED_REF_RE = /^(env|keyref):([A-Za-z0-9_.-]+)$/;

/** Parse a cred-ref; anything else is a configuration error (exit 1). */
export function parseCredRef(ref: string): CredRef {
  const m = CRED_REF_RE.exec(ref.trim());
  if (!m) {
    // The rejected value may be a pasted connection string: it is echoed only
    // through maskConnectionString, so a password in it never reaches output.
    throw new ThoughtsError(`invalid connection reference "${maskConnectionString(ref.trim())}"`, ExitCode.Validation, {
      hint: 'use env:<VARNAME> or keyref:<name> — never a connection string',
    });
  }
  return m[1] === 'env' ? { scheme: 'env', name: m[2]! } : { scheme: 'keyref', name: m[2]! };
}

/** True when the value looks like a ref rather than a literal connection string. */
export function isCredRef(value: string): boolean {
  return CRED_REF_RE.test(value.trim());
}

/** `keyrefs:` entries of the global config — the CLI-managed key store. */
function keyRefs(global: GlobalConfig | undefined): Record<string, unknown> {
  const raw = global?.['keyrefs'];
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Resolve a cred-ref to a connection string. A missing env var or keychain
 * entry is a configuration error (exit 1) that names the ref, so the message
 * is actionable without ever carrying the secret.
 */
export async function resolveCredRef(ref: string, opts: { global?: GlobalConfig } = {}): Promise<string> {
  const parsed = parseCredRef(ref);
  let value: string | undefined;
  if (parsed.scheme === 'env') {
    value = process.env[parsed.name];
    if (value === undefined || value.trim().length === 0) {
      throw new ThoughtsError(`connection reference ${parsed.scheme}:${parsed.name} is not set`, ExitCode.Validation, {
        hint: `set the environment variable, e.g. export ${parsed.name}='postgres://user:password@host:5432/database'`,
      });
    }
  } else {
    const global = opts.global ?? (await loadGlobalConfig());
    const entry = keyRefs(global)[parsed.name];
    value = typeof entry === 'string' && entry.length > 0 ? entry : undefined;
    if (value === undefined) {
      throw new ThoughtsError(`connection reference keyref:${parsed.name} has no stored secret`, ExitCode.Validation, {
        hint: `store it in the keyrefs: map of the thoughts global config, or use env:<VARNAME> instead`,
      });
    }
  }
  return value;
}

/**
 * Mask everything secret-looking in a connection string for diagnostics.
 * Used only on error paths; success paths never echo the string at all.
 */
export function maskConnectionString(text: string): string {
  return text
    // URL form: scheme://user:password@host/db
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]*:[^/@\s]*)@/gi, '$1***@')
    // keyword/DSN form: password=secret
    .replace(/(password\s*[=:]\s*)(\S+)/gi, '$1***')
    .replace(/(postgresql?:\/\/)\S+@/gi, '$1***@');
}
