/**
 * Console output. Supervisor-owned.
 *
 * Rules (CLAUDE.md principle 6): never print a matched secret unmasked, in any
 * level, including debug. Human output goes to stdout; warnings, errors and
 * debug go to stderr so `--json` stdout stays parseable.
 */
let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function isQuiet(): boolean {
  return quiet;
}

export function isDebug(): boolean {
  return process.env.THOUGHTS_DEBUG === '1' || process.env.THOUGHTS_DEBUG === 'true';
}

/** Normal human output. Suppressed by --quiet. */
export function info(message: string): void {
  if (!quiet) process.stdout.write(message + '\n');
}

/** Always printed to stdout, even with --quiet (used for --json and --print-path). */
export function print(message: string): void {
  process.stdout.write(message + '\n');
}

export function warn(message: string): void {
  process.stderr.write('warning: ' + message + '\n');
}

export function error(message: string): void {
  process.stderr.write('error: ' + message + '\n');
}

export function debug(message: string): void {
  if (isDebug()) process.stderr.write('debug: ' + message + '\n');
}
