/**
 * `<brain>/.thoughts-allow.yml` (specs/15 "Fixing and allow-listing").
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ALLOW_LIST_FILENAME } from '../paths.js';
import { ExitCode, ThoughtsError, type AllowEntry } from '../types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Entries of the allow list; a missing file yields `[]`. Malformed entries are skipped. */
export async function loadAllowList(brainRoot: string): Promise<AllowEntry[]> {
  const file = path.join(brainRoot, ALLOW_LIST_FILENAME);
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let data: unknown;
  try {
    data = YAML.parse(text);
  } catch (err) {
    throw new ThoughtsError('cannot parse ' + file + ': ' + (err as Error).message, ExitCode.Validation, {
      hint: 'fix the YAML syntax in ' + ALLOW_LIST_FILENAME,
      cause: err,
    });
  }
  const list = isRecord(data) ? data.allow : data;
  if (!Array.isArray(list)) return [];
  const entries: AllowEntry[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.fingerprint !== 'string' || item.fingerprint.length === 0) continue;
    entries.push({
      ...item,
      fingerprint: item.fingerprint,
      reason: typeof item.reason === 'string' ? item.reason : '',
      by: typeof item.by === 'string' ? item.by : '',
      at: typeof item.at === 'string' ? item.at : '',
    });
  }
  return entries;
}

/** Serialise an allow list (`allow:` sequence). Used by `scan --allow`. */
export function serializeAllowList(entries: AllowEntry[]): string {
  return YAML.stringify({ allow: entries }, { lineWidth: 0 });
}
