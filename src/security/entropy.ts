/**
 * Opt-in Shannon-entropy check on quoted strings (specs/15 "4. Entropy").
 * Hits are warnings, never blocks. Off unless `security.entropy: true`.
 */

const QUOTED = /(["'`])([^"'`\s]{20,})\1/g;

/** Bits per character, 0..~6 for ASCII. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Threshold in bits/char above which a quoted string is reported. */
export const ENTROPY_THRESHOLD = 4.2;

export interface EntropyHit {
  start: number;
  end: number;
  value: string;
}

/** Quoted strings of 20+ characters whose entropy exceeds the threshold. */
export function findHighEntropy(line: string): EntropyHit[] {
  const hits: EntropyHit[] = [];
  QUOTED.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = QUOTED.exec(line)) !== null) {
    const value = m[2] as string;
    // Skip things that are obviously not secrets: URLs, paths, prose with dashes only.
    if (/^[a-z]+:\/\//i.test(value) || value.startsWith('/')) continue;
    if (shannonEntropy(value) >= ENTROPY_THRESHOLD) {
      hits.push({ start: m.index + 1, end: m.index + 1 + value.length, value });
    }
  }
  return hits;
}
