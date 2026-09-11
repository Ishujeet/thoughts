/**
 * The managed block `init` inserts into a user-owned instruction file
 * (specs/02 step 5, specs/08 section 1). The only way `init` edits a user file.
 *
 * Guarantees: content outside the markers is byte-identical after the
 * operation; the file's own line endings are preserved; a missing file is
 * created; a block that already matches is left alone.
 */
import { ExitCode, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END, ThoughtsError } from '../types.js';

export type ManagedBlockState = 'created' | 'updated' | 'up-to-date';

export interface ManagedBlockResult {
  content: string;
  state: ManagedBlockState;
}

function detectEol(text: string): '\r\n' | '\n' {
  return /\r\n/.test(text) ? '\r\n' : '\n';
}

/** The block wrapped in its markers, using `eol`, always ending with `eol`. */
export function wrapManagedBlock(body: string, eol: '\r\n' | '\n' = '\n'): string {
  const normalised = body.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const lines = [MANAGED_BLOCK_BEGIN, ...normalised.split('\n'), MANAGED_BLOCK_END];
  return lines.join(eol) + eol;
}

/**
 * Insert or replace the managed block. `body` is the content that goes
 * between the markers (without the markers themselves).
 */
export function upsertManagedBlock(existing: string | undefined, body: string, fileName = 'instruction file'): ManagedBlockResult {
  if (existing === undefined || existing.length === 0) {
    return { content: wrapManagedBlock(body, '\n'), state: 'created' };
  }
  const eol = detectEol(existing);
  const block = wrapManagedBlock(body, eol);

  const beginIdx = existing.indexOf(MANAGED_BLOCK_BEGIN);
  const endIdx = existing.indexOf(MANAGED_BLOCK_END, beginIdx >= 0 ? beginIdx + MANAGED_BLOCK_BEGIN.length : 0);

  if (beginIdx === -1 && endIdx === -1) {
    // Append with one blank line before the block; never touch existing bytes.
    let sep = '';
    if (!existing.endsWith('\n')) sep = eol + eol;
    else if (!existing.endsWith(eol + eol) && !(eol === '\r\n' && existing.endsWith('\r\n\r\n'))) sep = eol;
    return { content: existing + sep + block, state: 'created' };
  }
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new ThoughtsError(`${fileName} has a malformed thoughts managed block (missing begin or end marker)`, ExitCode.FsConflict, {
      hint: `restore both markers or remove the partial block, then re-run: thoughts init`,
    });
  }
  // Replace from the begin marker through the end marker and the line ending that follows it.
  let after = endIdx + MANAGED_BLOCK_END.length;
  if (existing.startsWith('\r\n', after)) after += 2;
  else if (existing.startsWith('\n', after)) after += 1;
  const content = existing.slice(0, beginIdx) + block + existing.slice(after);
  return { content, state: content === existing ? 'up-to-date' : 'updated' };
}

/** Content between the markers of `text`, or undefined when there is no block. */
export function readManagedBlock(text: string): string | undefined {
  const beginIdx = text.indexOf(MANAGED_BLOCK_BEGIN);
  if (beginIdx === -1) return undefined;
  const start = beginIdx + MANAGED_BLOCK_BEGIN.length;
  const endIdx = text.indexOf(MANAGED_BLOCK_END, start);
  if (endIdx === -1) return undefined;
  return text.slice(start, endIdx).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}
