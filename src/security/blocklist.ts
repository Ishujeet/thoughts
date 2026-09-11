/**
 * Filename blocklist (specs/15 "1. Filename blocklist"). Matched on the
 * basename, regardless of content.
 */
import path from 'node:path';

const EXACT = new Set(['.env', 'credentials', 'credentials.json', '.netrc', '.npmrc', '.pypirc']);

const PATTERNS: readonly RegExp[] = [
  /^\.env\..+$/, // .env.local, .env.production
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.jks$/i,
  /^id_rsa/, // id_rsa, id_rsa.pub, id_rsa_work
  /^id_ed25519/,
  /\.kdbx$/i,
  /^service-account.*\.json$/i,
];

/** True when the basename of `p` is on the blocklist. */
export function isBlockedFilename(p: string): boolean {
  const base = path.posix.basename(p.replace(/\\/g, '/'));
  if (base.length === 0) return false;
  if (EXACT.has(base)) return true;
  return PATTERNS.some((re) => re.test(base));
}
