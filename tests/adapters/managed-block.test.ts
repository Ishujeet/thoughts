import { describe, expect, it } from 'vitest';
import { readManagedBlock, upsertManagedBlock, wrapManagedBlock } from '../../src/adapters/managed-block.js';
import { ExitCode, MANAGED_BLOCK_BEGIN, MANAGED_BLOCK_END, ThoughtsError } from '../../src/types.js';

const body = '## Project brain (thoughts)\n\n- line one\n- line two';

describe('upsertManagedBlock', () => {
  it('creates the file content when there is no file', () => {
    const r = upsertManagedBlock(undefined, body);
    expect(r.state).toBe('created');
    expect(r.content).toBe(`${MANAGED_BLOCK_BEGIN}\n${body}\n${MANAGED_BLOCK_END}\n`);
    expect(readManagedBlock(r.content)).toBe(body);
  });

  it('appends after a blank line and keeps existing bytes identical', () => {
    for (const existing of ['# my notes', '# my notes\n', '# my notes\n\n', '# a\n\nsome *text*\n']) {
      const r = upsertManagedBlock(existing, body);
      expect(r.state).toBe('created');
      expect(r.content.startsWith(existing)).toBe(true);
      const outside = r.content.slice(0, r.content.indexOf(MANAGED_BLOCK_BEGIN));
      expect(outside.replace(/\n+$/, '')).toBe(existing.replace(/\n+$/, ''));
      expect(outside.endsWith('\n\n')).toBe(true);
      expect(r.content.endsWith(MANAGED_BLOCK_END + '\n')).toBe(true);
    }
  });

  it('replaces only what is between the markers', () => {
    const before = '# custom\n\ntext before\n';
    const after = '\ntext after\n- bullet\n';
    const existing = before + wrapManagedBlock('old content') + after;
    const r = upsertManagedBlock(existing, body);
    expect(r.state).toBe('updated');
    expect(r.content).toBe(before + wrapManagedBlock(body) + after);
    expect(upsertManagedBlock(r.content, body)).toEqual({ content: r.content, state: 'up-to-date' });
  });

  it('preserves CRLF line endings outside and inside the block', () => {
    const existing = '# notes\r\n\r\nline\r\n';
    const r = upsertManagedBlock(existing, body);
    expect(r.content.startsWith(existing)).toBe(true);
    expect(r.content).not.toMatch(/[^\r]\n/);
    expect(r.content.endsWith(MANAGED_BLOCK_END + '\r\n')).toBe(true);
    const again = upsertManagedBlock(r.content, body);
    expect(again.state).toBe('up-to-date');
    const changed = upsertManagedBlock(r.content, body + '\n- three');
    expect(changed.state).toBe('updated');
    expect(changed.content.startsWith(existing)).toBe(true);
    expect(changed.content).not.toMatch(/[^\r]\n/);
  });

  it('refuses a malformed block (one marker only)', () => {
    let err: unknown;
    try {
      upsertManagedBlock('x\n' + MANAGED_BLOCK_BEGIN + '\nstuff\n', body, 'CLAUDE.md');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ThoughtsError);
    expect((err as ThoughtsError).exitCode).toBe(ExitCode.FsConflict);
    expect((err as ThoughtsError).message).toContain('CLAUDE.md');
  });
});
