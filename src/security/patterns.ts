/**
 * Detector table (specs/15 "2. Known-format patterns", "3. Generic assignment
 * pattern"). Every regex here is compiled once at module load.
 *
 * Never log a matched value from this module; the scanner masks before it
 * builds a Finding.
 */
import type { FindingSeverity } from '../types.js';

export interface DetectorMatch {
  /** Start offset within the line. */
  start: number;
  /** End offset within the line (exclusive). */
  end: number;
  /** The text to mask (usually the whole match; the password for connection strings). */
  masked: string;
}

export interface Detector {
  /** Human-readable kind label, e.g. `stripe secret key`. */
  kind: string;
  severity: FindingSeverity;
  /** Global, sticky-less regex. `exec` is reset by the scanner before each line. */
  regex: RegExp;
  /**
   * Which capture group holds the secret value for placeholder checks; when
   * set, the value is checked against the placeholder rules before reporting.
   */
  valueGroup?: number;
  /** Connection string: mask only the password (group `passwordGroup`). */
  passwordGroup?: number;
  /** Mask the whole match even when `valueGroup` is set (the value is only used for the placeholder check). */
  maskWhole?: boolean;
  /**
   * Only structural placeholders (`<…>`, `${…}`, `xxx`, `***`, …) exempt the
   * value; a password inside a fully formed URL that merely starts with a word
   * such as `example` is still reported.
   */
  strictPlaceholder?: boolean;
}

// ---------------------------------------------------------------------------
// Placeholders (spec 15 "3."): never flagged. Every pattern is anchored to the
// whole value or its start: a real secret that merely contains a word such as
// `example` or `redacted` somewhere inside must still be flagged.
// ---------------------------------------------------------------------------

/** Placeholders recognised by their shape; these apply everywhere, including URL passwords. */
const STRUCTURAL_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^<.*>$/, // <your-password>
  /^\$\{.*\}$/, // ${API_TOKEN}
  /^\$[A-Za-z_][A-Za-z0-9_]*$/, // $API_TOKEN
  /^\{\{.*\}\}$/, // {{ token }}
  /^%\(.*\)s$/, // %(token)s
  /^x+$/i, // xxxxxxxxxxxx
  /^[*•]+$/, // ************
  /^[-_.]+$/, // ------------
  /^changeme/i,
  /^change[-_]?me/i,
  /^your[-_].*[-_]here$/i,
  /^redacted(?:[-_.\s]|$)/i, // REDACTED, REDACTED_BY_SECURITY — never a mid-value substring
  /^<redacted:.*>$/i,
  /^(?:null|none|undefined|true|false)$/i,
];

/** Placeholders recognised by a leading word (`example-key`, `your-token`, `dummy_secret`). */
const WORD_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^example/i,
  /^your[-_]/i,
  /^placeholder/i,
  /^(?:dummy|sample|fake)[-_]?/i,
];

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [...STRUCTURAL_PLACEHOLDER_PATTERNS, ...WORD_PLACEHOLDER_PATTERNS];

/**
 * True when `value` is an obvious placeholder or is shorter than 12 characters.
 * With `strict`, only structural placeholders count (see `Detector.strictPlaceholder`).
 */
export function isPlaceholder(value: string, strict = false): boolean {
  const v = value.trim().replace(/^['"`]|['"`]$/g, '');
  if (v.length < 12) return true;
  return (strict ? STRUCTURAL_PLACEHOLDER_PATTERNS : PLACEHOLDER_PATTERNS).some((p) => p.test(v));
}

// ---------------------------------------------------------------------------
// Known-format detectors (ordered most specific first; overlapping later
// matches on the same span are dropped by the scanner).
// ---------------------------------------------------------------------------

const B64 = 'A-Za-z0-9/+=';
const TOKEN = 'A-Za-z0-9_\\-';

export const KNOWN_DETECTORS: readonly Detector[] = [
  { kind: 'private key', severity: 'block', regex: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'aws access key', severity: 'block', regex: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  {
    kind: 'aws secret key',
    severity: 'block',
    regex: new RegExp('aws_secret_access_key\\s*[:=]\\s*[\'"]?([' + B64 + ']{40})(?![' + B64 + '])', 'gi'),
    valueGroup: 1,
  },
  { kind: 'github token', severity: 'block', regex: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'github token', severity: 'block', regex: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'gitlab token', severity: 'block', regex: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_\-]{20,}/g },
  { kind: 'slack token', severity: 'block', regex: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  {
    kind: 'slack webhook',
    severity: 'block',
    // Include the scheme when present so the masked form (`http****…`) reveals nothing of the URL path.
    regex: /(?:https?:\/\/)?hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/g,
  },
  { kind: 'google api key', severity: 'block', regex: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_\-]{35}(?![0-9A-Za-z_\-])/g },
  { kind: 'stripe secret key', severity: 'block', regex: /(?<![A-Za-z0-9])(?:sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9]{10,}/g },
  { kind: 'stripe webhook secret', severity: 'block', regex: /(?<![A-Za-z0-9])whsec_[A-Za-z0-9]{10,}/g },
  { kind: 'anthropic api key', severity: 'block', regex: new RegExp('(?<![A-Za-z0-9])sk-ant-[' + TOKEN + ']{20,}', 'g') },
  { kind: 'openai api key', severity: 'block', regex: new RegExp('(?<![A-Za-z0-9])sk-proj-[' + TOKEN + ']{20,}', 'g') },
  { kind: 'openai api key', severity: 'block', regex: new RegExp('(?<![A-Za-z0-9])sk-[' + TOKEN + ']{20,}', 'g') },
  {
    kind: 'personal access token',
    severity: 'block',
    regex: /(?<![A-Za-z0-9_])(?:pat|azure_devops_token|azure_devops_pat|ado_pat|jira_token|jira_api_token|atlassian_api_token)\s*[:=]\s*['"]?([A-Za-z0-9._\-]{24,})/gi,
    valueGroup: 1,
  },
  { kind: 'twilio api key', severity: 'block', regex: /(?<![A-Za-z0-9])SK[0-9a-fA-F]{32}(?![A-Za-z0-9])/g },
  { kind: 'sendgrid api key', severity: 'block', regex: new RegExp('(?<![A-Za-z0-9])SG\\.[' + TOKEN + ']{16,}\\.[' + TOKEN + ']{16,}', 'g') },
  { kind: 'mailgun api key', severity: 'block', regex: /(?<![A-Za-z0-9])key-[0-9a-zA-Z]{32}(?![A-Za-z0-9])/g },
  { kind: 'npm token', severity: 'block', regex: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}/g },
  { kind: 'pypi token', severity: 'block', regex: new RegExp('(?<![A-Za-z0-9])pypi-[' + TOKEN + ']{20,}', 'g') },
  { kind: 'docker hub token', severity: 'block', regex: new RegExp('(?<![A-Za-z0-9])dckr_pat_[' + TOKEN + ']{20,}', 'g') },
  { kind: 'vault token', severity: 'block', regex: new RegExp('(?<![A-Za-z0-9])hvs\\.[' + TOKEN + ']{20,}', 'g') },
  { kind: 'jwt', severity: 'block', regex: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g },
  {
    kind: 'connection string',
    severity: 'block',
    regex: /(?<![A-Za-z0-9])((?:jdbc:)?(?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|sqlserver):\/\/)([^:\/\s@'"]+):([^@\s'"]+)@([^\s'"`)>\]]+)/gi,
    passwordGroup: 3,
    valueGroup: 3,
    strictPlaceholder: true,
  },
  {
    // Any other `scheme://user:password@host` (http, https, git, ssh, …). The db
    // schemes above win on overlap; the whole URL is masked so nothing of the
    // credential leaks. `user@host` without a password never matches.
    kind: 'url credentials',
    severity: 'block',
    regex: /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)([^:\/\s@'"]+):([^@\s'"]+)@([^\s'"`)>\]]+)/gi,
    valueGroup: 3,
    maskWhole: true,
    strictPlaceholder: true,
  },
  {
    kind: 'azure storage connection string',
    severity: 'block',
    regex: /DefaultEndpointsProtocol=[^\s'"]{20,}/g,
  },
  {
    kind: 'azure account key',
    severity: 'block',
    regex: new RegExp('AccountKey=([' + B64 + ']{20,})', 'g'),
    valueGroup: 1,
  },
  {
    kind: 'azure shared access signature',
    severity: 'block',
    regex: /SharedAccessSignature=([^\s;'"]{20,})/g,
    valueGroup: 1,
  },
];

/** Google service-account JSON: `"type": "service_account"` together with `"private_key"` in one file. */
export const SERVICE_ACCOUNT_TYPE = /"type"\s*:\s*"service_account"/;
export const SERVICE_ACCOUNT_KEY = /"private_key"\s*:\s*"([^"]{8,})"/g;
export const SERVICE_ACCOUNT_KIND = 'google service account';

// ---------------------------------------------------------------------------
// Generic assignment pattern (spec 15 "3.")
// ---------------------------------------------------------------------------

export const GENERIC_KEYWORDS = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|bearer|private[_-]?key|client[_-]?secret/i;

export const GENERIC_ASSIGNMENT: Detector = {
  kind: 'generic secret assignment',
  severity: 'block',
  regex: /(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|bearer|private[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9/+=_\-.]{12,})/gi,
  valueGroup: 2,
};

/** Inline suppression on the line above a match (spec 15 "Fixing and allow-listing"). */
export const INLINE_ALLOW = /<!--\s*thoughts:allow-secret\s+reason\s*=\s*"([^"]*)"\s*-->/;
