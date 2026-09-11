/**
 * OKF concept frontmatter: parse, serialise, validate (specs/09).
 */
import fs from 'node:fs';
import YAML from 'yaml';
import {
  ExitCode,
  ThoughtsError,
  type Actor,
  type Frontmatter,
  type LintIssue,
  type Thought,
  type ThoughtStatus,
  type TrustTier,
} from '../types.js';
import { expectedRepoField, locate } from './location.js';

export const THOUGHT_STATUSES: readonly ThoughtStatus[] = ['draft', 'stable', 'deprecated'];

export interface ParsedFrontmatter {
  frontmatter: Frontmatter;
  body: string;
  hasFrontmatter: boolean;
  /** Raw YAML between the fences (present whenever a fence pair was found). */
  raw?: string;
  /** YAML error message when the block could not be parsed as a mapping. */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Split a document into frontmatter and body. Never throws: a missing block
 * yields `hasFrontmatter: false` with the whole text as body; a YAML error is
 * reported in `error` (and `hasFrontmatter` is false). Accepts LF or CRLF.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const start = open[0].length;
  const close = /^---[ \t]*(?:\r?\n|$)/m;
  const rest = text.slice(start);
  // Find a closing fence at the start of a line.
  let searchFrom = 0;
  let closeIndex = -1;
  let closeLength = 0;
  for (;;) {
    const sub = rest.slice(searchFrom);
    const m = close.exec(sub);
    if (!m) break;
    const idx = searchFrom + m.index;
    if (idx === 0 || rest[idx - 1] === '\n') {
      closeIndex = idx;
      closeLength = m[0].length;
      break;
    }
    searchFrom = idx + 1;
  }
  if (closeIndex < 0) {
    return { frontmatter: {}, body: text, hasFrontmatter: false, raw: rest, error: 'closing frontmatter fence (---) not found' };
  }
  const raw = rest.slice(0, closeIndex);
  const body = rest.slice(closeIndex + closeLength);
  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (err) {
    return { frontmatter: {}, body, hasFrontmatter: false, raw, error: (err as Error).message.split('\n')[0] ?? 'invalid YAML' };
  }
  if (data === null || data === undefined) return { frontmatter: {}, body, hasFrontmatter: true, raw };
  if (!isRecord(data)) {
    return { frontmatter: {}, body, hasFrontmatter: false, raw, error: 'frontmatter is not a YAML mapping' };
  }
  return { frontmatter: data as Frontmatter, body, hasFrontmatter: true, raw };
}

/** Read and parse a concept file. `relPath` is bundle-relative (leading slash optional). */
export async function parseThought(absPath: string, relPath: string): Promise<Thought> {
  const location = locate(relPath);
  if (!location) {
    throw new ThoughtsError('not a thought path: ' + relPath, ExitCode.Validation, {
      hint: 'thoughts live under shared/, repos/<id>/ or users/<id>/ and are not index.md or log.md',
    });
  }
  const text = await fs.promises.readFile(absPath, 'utf8');
  const parsed = parseFrontmatter(text);
  const thought: Thought = {
    location,
    absPath,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    hasFrontmatter: parsed.hasFrontmatter,
  };
  if (parsed.raw !== undefined) thought.rawFrontmatter = parsed.raw;
  return thought;
}

/** `---\n<yaml>\n---\n<body>`. Unknown keys and key order are preserved; body verbatim. */
export function serializeThought(frontmatter: Frontmatter, body: string): string {
  const yaml = YAML.stringify(frontmatter, { lineWidth: 0 });
  const block = Object.keys(frontmatter).length === 0 ? '' : yaml.endsWith('\n') ? yaml : yaml + '\n';
  return '---\n' + block + '---\n' + body;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** Extra OKF types declared by the brain. Unknown types are tolerated either way. */
  knownTypes?: string[];
  /** Reference time for `okf/stale`. Default: now. */
  now?: Date;
}

const REQUIRED_FIELDS: readonly (keyof Frontmatter & string)[] = ['type', 'title', 'status', 'generated', 'repo'];

/** 1-based line of a top-level `key:` inside the file, or 1 when not found. */
function keyLine(raw: string | undefined, key: string): number {
  if (!raw) return 1;
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp('^' + key + '\\s*:').test(lines[i] as string)) return i + 2; // +1 for the opening fence, +1 for 1-based
  }
  return 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isActor(value: unknown): value is Actor {
  return isRecord(value) && isNonEmptyString(value.by) && isNonEmptyString(value.at);
}

export function validateThought(t: Thought, opts: ValidateOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const p = t.location.path;
  const issue = (severity: LintIssue['severity'], rule: string, message: string, line?: number): void => {
    const li: LintIssue = { severity, path: p, rule, message };
    if (line !== undefined) li.line = line;
    issues.push(li);
  };

  if (!t.hasFrontmatter) {
    if (t.rawFrontmatter === undefined) {
      issue('error', 'okf/frontmatter', 'frontmatter missing', 1);
    } else {
      const reparsed = parseFrontmatter('---\n' + t.rawFrontmatter + '---\n');
      issue('error', 'okf/frontmatter', 'frontmatter unparsable: ' + (reparsed.error ?? 'invalid YAML'), 1);
    }
    return issues;
  }

  const fm = t.frontmatter;
  const raw = t.rawFrontmatter;

  for (const field of REQUIRED_FIELDS) {
    const value = fm[field];
    if (field === 'generated') {
      if (!isRecord(value)) {
        issue('error', 'okf/missing-field', 'generated missing', 1);
      } else {
        if (!isNonEmptyString(value.by)) issue('error', 'okf/missing-field', 'generated.by missing', keyLine(raw, 'generated'));
        if (!isNonEmptyString(value.at)) issue('error', 'okf/missing-field', 'generated.at missing', keyLine(raw, 'generated'));
      }
      continue;
    }
    if (!isNonEmptyString(value)) issue('error', 'okf/missing-field', field + ' missing', 1);
  }

  if (isNonEmptyString(fm.status) && !THOUGHT_STATUSES.includes(fm.status as ThoughtStatus)) {
    issue(
      'error',
      'okf/bad-status',
      'status must be one of ' + THOUGHT_STATUSES.join(', ') + ' (got ' + fm.status + ')',
      keyLine(raw, 'status'),
    );
  }

  if (isNonEmptyString(fm.repo)) {
    const expected = expectedRepoField(t.location);
    if (fm.repo !== expected) {
      issue('error', 'okf/repo-mismatch', 'repo is ' + fm.repo + ' but path implies ' + expected, keyLine(raw, 'repo'));
    }
  }

  if (fm.status === 'stable' && !isNonEmptyString(fm.description)) {
    issue('warning', 'okf/empty-description', 'description is empty on a stable thought', keyLine(raw, 'description'));
  }

  if (isNonEmptyString(fm.stale_after) && fm.status !== 'deprecated') {
    const when = new Date(fm.stale_after);
    const now = opts.now ?? new Date();
    if (!Number.isNaN(when.getTime()) && when.getTime() < now.getTime()) {
      issue('warning', 'okf/stale', 'stale_after ' + fm.stale_after + ' is in the past and status is not deprecated', keyLine(raw, 'stale_after'));
    }
  }

  return issues;
}

/** Trust tier exactly as the OKF table in specs/09. */
export function trustTier(fm: Frontmatter): TrustTier {
  const verified = Array.isArray(fm.verified) ? fm.verified.filter(isActor) : [];
  if (verified.length === 0) return 'unverified';
  if (verified.some((v) => v.by.startsWith('human:'))) return 'human-reviewed';
  return 'machine-confirmed';
}
