/**
 * Secret scanner (specs/15, D21).
 *
 * Rules that hold everywhere in this module: the raw matched value is never
 * stored in a Finding, thrown in a message, or logged. Only `masked` leaves
 * this file. Built-in detectors cannot be disabled; custom patterns add.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, ThoughtsError, type AllowEntry, type CustomPattern, type Finding, type ScanOptions } from '../types.js';
import { isBlockedFilename } from './blocklist.js';
import { findHighEntropy } from './entropy.js';
import {
  GENERIC_ASSIGNMENT,
  GENERIC_KEYWORDS,
  INLINE_ALLOW,
  KNOWN_DETECTORS,
  SERVICE_ACCOUNT_KEY,
  SERVICE_ACCOUNT_KIND,
  SERVICE_ACCOUNT_TYPE,
  isPlaceholder,
  type Detector,
} from './patterns.js';

export const MAX_SCAN_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

// ---------------------------------------------------------------------------
// Masking and fingerprints
// ---------------------------------------------------------------------------

/** First 4 characters + `*` × min(len − 4, 16); values of 4 chars or fewer → `****`. */
export function mask(value: string): string {
  if (value.length <= 4) return '****';
  return value.slice(0, 4) + '*'.repeat(Math.min(value.length - 4, 16));
}

/**
 * `sha256:` + hex of `path + "\n" + kind + "\n" + masked + "\n" + hex(sha256(raw))`.
 *
 * Binding the raw value (hashed, never stored) means that changing a secret
 * invalidates an allow-list entry even when the new value keeps the same
 * masked form; the line number stays out so a value that moves keeps its
 * fingerprint. `raw` is consumed in-process only.
 */
export function fingerprint(p: string, kind: string, masked: string, raw: string): string {
  const rawHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  return 'sha256:' + createHash('sha256').update(p + '\n' + kind + '\n' + masked + '\n' + rawHash, 'utf8').digest('hex');
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'block' || f.severity === 'unscannable');
}

function makeFinding(p: string, line: number, kind: string, severity: Finding['severity'], masked: string, raw: string): Finding {
  return { path: p, line, kind, severity, masked, fingerprint: fingerprint(p, kind, masked, raw) };
}

// ---------------------------------------------------------------------------
// Custom patterns (compiled once per distinct regex string)
// ---------------------------------------------------------------------------

const customCache = new Map<string, Detector>();

function compileCustom(p: CustomPattern): Detector {
  const key = p.name + '\0' + p.regex + '\0' + p.severity;
  const cached = customCache.get(key);
  if (cached) return cached;
  let regex: RegExp;
  try {
    regex = new RegExp(p.regex, 'g');
  } catch (err) {
    throw new ThoughtsError('invalid security pattern ' + p.name + ': ' + (err as Error).message, ExitCode.Validation, {
      hint: 'fix security.patterns[].regex in brain.yml',
      cause: err,
    });
  }
  const det: Detector = { kind: p.name, severity: p.severity === 'warn' ? 'warn' : 'block', regex };
  customCache.set(key, det);
  return det;
}

// ---------------------------------------------------------------------------
// Line scanning
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

function overlaps(spans: Span[], s: Span): boolean {
  return spans.some((o) => s.start < o.end && o.start < s.end);
}

interface LineHit {
  kind: string;
  severity: Finding['severity'];
  masked: string;
  /** Raw matched value: consumed by `fingerprint` only, never copied onto a Finding. */
  raw: string;
  span: Span;
}

function runDetector(det: Detector, line: string, taken: Span[], out: LineHit[]): void {
  det.regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = det.regex.exec(line)) !== null) {
    if (m[0].length === 0) {
      det.regex.lastIndex += 1;
      continue;
    }
    const span: Span = { start: m.index, end: m.index + m[0].length };
    if (overlaps(taken, span)) continue;
    if (det.valueGroup !== undefined) {
      const value = m[det.valueGroup] ?? '';
      if (isPlaceholder(value, det.strictPlaceholder === true)) continue;
    }
    let masked: string;
    let raw: string;
    if (det.passwordGroup !== undefined) {
      // postgres://user:****@host — mask only the password part.
      const scheme = m[1] ?? '';
      const user = m[2] ?? '';
      const rest = m[4] ?? '';
      masked = scheme + user + ':****@' + rest;
      raw = m[det.passwordGroup] ?? m[0];
    } else if (det.valueGroup !== undefined && !det.maskWhole) {
      // Assignment-style detectors (`aws_secret_access_key = …`, `password: …`):
      // the secret is the value, so mask that rather than the `key = ` prefix.
      raw = m[det.valueGroup] ?? m[0];
      masked = mask(raw);
    } else {
      raw = m[0];
      masked = mask(raw);
    }
    taken.push(span);
    out.push({ kind: det.kind, severity: det.severity, masked, raw, span });
  }
}

/** Placeholder-aware generic assignment check. */
function runGeneric(line: string, taken: Span[], out: LineHit[]): void {
  // Spec 15 "Performance": the generic pattern runs only on lines with a keyword.
  if (!GENERIC_KEYWORDS.test(line)) return;
  runDetector(GENERIC_ASSIGNMENT, line, taken, out);
}

function scanLines(text: string, displayPath: string, opts: ScanOptions): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split(/\r?\n/);
  const custom = (opts.customPatterns ?? []).map(compileCustom);
  const serviceAccount = SERVICE_ACCOUNT_TYPE.test(text);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.length === 0) continue;
    const taken: Span[] = [];
    const hits: LineHit[] = [];

    if (serviceAccount) {
      SERVICE_ACCOUNT_KEY.lastIndex = 0;
      const m = SERVICE_ACCOUNT_KEY.exec(line);
      if (m && !isPlaceholder(m[1] as string)) {
        const span = { start: m.index, end: m.index + m[0].length };
        taken.push(span);
        hits.push({ kind: SERVICE_ACCOUNT_KIND, severity: 'block', masked: mask(m[1] as string), raw: m[1] as string, span });
      }
    }
    for (const det of KNOWN_DETECTORS) runDetector(det, line, taken, hits);
    for (const det of custom) runDetector(det, line, taken, hits);
    runGeneric(line, taken, hits);
    if (opts.entropy) {
      for (const hit of findHighEntropy(line)) {
        const span = { start: hit.start, end: hit.end };
        if (overlaps(taken, span)) continue;
        taken.push(span);
        hits.push({ kind: 'high entropy string', severity: 'warn', masked: mask(hit.value), raw: hit.value, span });
      }
    }
    if (hits.length === 0) continue;

    // Inline allow on the previous line, with a non-empty reason.
    const prev = i > 0 ? (lines[i - 1] as string) : '';
    const allow = INLINE_ALLOW.exec(prev);
    if (allow && (allow[1] ?? '').trim().length > 0) continue;

    hits.sort((a, b) => a.span.start - b.span.start);
    for (const hit of hits) findings.push(makeFinding(displayPath, i + 1, hit.kind, hit.severity, hit.masked, hit.raw));
  }
  return findings;
}

function applyAllowList(findings: Finding[], allow: AllowEntry[] | undefined): Finding[] {
  if (!allow || allow.length === 0) return findings;
  const allowed = new Set(allow.map((a) => a.fingerprint));
  return findings.filter((f) => !allowed.has(f.fingerprint));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Scan a string. `displayPath` is the bundle-relative path or `--set <key>`. */
export function scanText(text: string, displayPath: string, opts: ScanOptions = {}): Finding[] {
  return applyAllowList(scanLines(text, displayPath, opts), opts.allow);
}

async function isBinary(absPath: string): Promise<boolean> {
  const fh = await fs.promises.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(BINARY_PROBE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_PROBE_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/** Blocklist → size/binary → content. Missing files throw (callers that expect deletions use `scanFiles`). */
export async function scanFile(absPath: string, displayPath: string, opts: ScanOptions = {}): Promise<Finding[]> {
  if (isBlockedFilename(displayPath) || isBlockedFilename(absPath)) {
    return applyAllowList([makeFinding(displayPath, 0, 'blocked filename', 'block', '', '')], opts.allow);
  }
  const st = await fs.promises.stat(absPath);
  if (st.size > MAX_SCAN_BYTES) {
    return applyAllowList([makeFinding(displayPath, 0, 'unscannable: larger than 1 MB', 'unscannable', '', '')], opts.allow);
  }
  if (await isBinary(absPath)) {
    return applyAllowList([makeFinding(displayPath, 0, 'unscannable: binary file', 'unscannable', '', '')], opts.allow);
  }
  const text = await fs.promises.readFile(absPath, 'utf8');
  return scanText(text, displayPath, opts);
}

function toDisplayPath(rel: string): string {
  let p = rel.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

/** Scan several files under `root`. Paths that no longer exist (deleted) are skipped. */
export async function scanFiles(root: string, relPaths: string[], opts: ScanOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const rel of relPaths) {
    const display = toDisplayPath(rel);
    const abs = path.join(root, display.slice(1));
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw err;
    }
    if (!st.isFile()) continue;
    findings.push(...(await scanFile(abs, display, opts)));
  }
  return findings;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // specs/17: a repo's generated `codegraph/` data is never scanned.
      if (entry.name === 'codegraph' && /(^|\/)repos\/[^/]+$/.test(path.relative(root, dir).split(path.sep).join('/'))) continue;
      await walk(root, full, out);
    } else if (entry.isFile()) out.push('/' + path.relative(root, full).split(path.sep).join('/'));
  }
}

/** Every file under `root` except `.git/` and the repos' `codegraph/` data. */
export async function scanTree(root: string, opts: ScanOptions = {}): Promise<Finding[]> {
  const files: string[] = [];
  await walk(root, root, files);
  files.sort();
  return scanFiles(root, files, opts);
}
