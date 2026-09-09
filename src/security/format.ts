/**
 * Finding output (specs/15 "Output"). Values are already masked.
 */
import type { Finding } from '../types.js';

export const FIX_LINE = 'Fix:  edit the lines above, or run   thoughts scan --fix   to redact them.';
export const THEN_LINE = 'Then: rotate any real credential that was exposed. Scanning does not un-leak it.';

function displayPath(f: Finding): string {
  // Bundle-relative paths are shown without the leading slash, as in the spec.
  const p = f.path.startsWith('/') ? f.path.slice(1) : f.path;
  return f.line > 0 ? p + ':' + f.line : p;
}

export function formatFindings(findings: Finding[], opts: { json?: boolean; verb?: string } = {}): string {
  if (opts.json) {
    return JSON.stringify(
      findings.map((f) => ({
        path: f.path,
        line: f.line,
        kind: f.kind,
        severity: f.severity,
        masked: f.masked,
        fingerprint: f.fingerprint,
      })),
      null,
      2,
    );
  }
  const verb = opts.verb ?? 'commit';
  const lines: string[] = ['✗ secret found — refusing to ' + verb, ''];
  for (const f of findings) {
    lines.push('  ' + displayPath(f));
    lines.push('    ' + f.kind.padEnd(22) + ' ' + f.masked);
  }
  lines.push('', FIX_LINE, THEN_LINE);
  return lines.join('\n');
}
