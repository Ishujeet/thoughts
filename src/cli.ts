/**
 * commander program. Owned by the "commands" package after scaffold.
 *
 * Responsibilities (see the contract):
 *  - register every command from src/commands/*
 *  - map ThoughtsError -> exit code, SecretFoundError -> print masked findings then exit 7
 *  - unknown errors -> exit 1, stack only when THOUGHTS_DEBUG=1
 */
import { Command } from 'commander';
import { cliVersion } from './assets.js';
import * as out from './output.js';
import { ExitCode, SecretFoundError, ThoughtsError } from './types.js';

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('thoughts')
    .description('Attach a shared, git-backed brain to every repo in a multi-repo project.')
    .version(cliVersion(), '-v, --version')
    .showHelpAfterError();
  // TODO(commands package): register init / sync / new here.
  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return ExitCode.Ok;
  } catch (err) {
    return handleError(err);
  }
}

export function handleError(err: unknown): number {
  // commander's own exits (help, version, usage errors)
  if (typeof err === 'object' && err !== null && 'exitCode' in err && 'code' in err) {
    const e = err as { exitCode: number; code: string };
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') return ExitCode.Ok;
    return e.exitCode === 0 ? ExitCode.Ok : ExitCode.Validation;
  }
  if (err instanceof SecretFoundError) {
    // Findings are already masked by the scanner; formatting lives in src/security.
    out.error(err.message);
    for (const f of err.findings) {
      out.print(`  ${f.path}:${f.line}\n    ${f.kind.padEnd(22)} ${f.masked}`);
    }
    if (err.hint) out.print('\n' + err.hint);
    return err.exitCode;
  }
  if (err instanceof ThoughtsError) {
    out.error(err.message);
    if (err.hint) process.stderr.write(err.hint + '\n');
    return err.exitCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  out.error(message);
  if (out.isDebug() && err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  return ExitCode.Validation;
}
