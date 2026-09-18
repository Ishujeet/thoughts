/**
 * Backend selection (specs/16 "Backend kinds"): the descriptor in `brain.yml`
 * wins, then the scheme of the brain ref (`.thoughts.yml` `brain:` /
 * `--brain`), then the git default.
 *
 * `psql` builds a PgBackend and `nebula` a NebulaBackend; their credentials
 * live behind a cred-ref (specs/10) in the global config or `--connection-ref`,
 * never in the brain. Git brains take the exact path they always took.
 */
import path from 'node:path';
import { ExitCode, ThoughtsError, type BrainConfig } from '../../types.js';
import { loadGlobalConfig } from '../config.js';
import { PgBackend } from './pg.js';
import { NebulaBackend } from './nebula.js';
import { GitBackend } from './git.js';
import { parseBackendDescriptor, type BackendKind, type BrainBackend } from './types.js';

export interface BackendContext {
  brainId: string;
  /** Absolute path of the brain workspace (`~/.thoughts/brains/<id>/`). */
  workspace: string;
  /** Parsed `brain.yml`, when it exists yet. */
  brain?: BrainConfig;
  /** The brain ref a repo or `--brain` carries; may be scheme-prefixed. */
  brainRef?: string;
  /** Cred-ref (`env:VAR` / `keyref:name`) for non-git stores (specs/10). */
  connectionRef?: string;
}

/** The backend kind a brain ref names, from its scheme (`postgres:`, `nebula:`). */
export function kindFromRef(ref: string | undefined): BackendKind | undefined {
  if (ref === undefined) return undefined;
  const s = ref.trim();
  if (s.startsWith('postgres:')) return 'psql';
  if (s.startsWith('nebula:')) return 'nebula';
  return undefined;
}

/** Kind for a brain: `brain.yml` `backend.kind`, else the ref scheme, else git. */
export function backendKind(ctx: BackendContext): BackendKind {
  return parseBackendDescriptor(ctx.brain?.backend)?.kind ?? kindFromRef(ctx.brainRef) ?? 'git';
}

/**
 * The cred-ref a psql/nebula store connects with: `--connection-ref` wins, then
 * the global config's `brains.<id>.connection_ref` (specs/10: credentials
 * outside the brain, referenced from global config). With none, the error names
 * the env var the user must provide (specs/16 exit-code table, exit 1).
 */
export async function connectionRefFor(ctx: BackendContext, kind: BackendKind): Promise<string> {
  if (ctx.connectionRef !== undefined && ctx.connectionRef.trim().length > 0) return ctx.connectionRef.trim();
  const global = await loadGlobalConfig();
  const stored = global.brains[ctx.brainId]?.['connection_ref'];
  if (typeof stored === 'string' && stored.trim().length > 0) return stored.trim();
  const fallback = kind === 'nebula' ? 'THOUGHTS_NEBULA' : 'THOUGHTS_BRAIN_PG';
  throw new ThoughtsError(
    `backend "${kind}" needs a connection reference for brain "${ctx.brainId}" — none is configured`, ExitCode.Validation, {
      hint: `pass --connection-ref env:${fallback} (or set brains.${ctx.brainId}.connection_ref in the thoughts global config), then set the variable`,
    },
  );
}

/** Build the backend a command drives the brain store through. */
export async function resolveBackend(ctx: BackendContext): Promise<BrainBackend> {
  const kind = backendKind(ctx);
  if (kind === 'git') return new GitBackend({ brainId: ctx.brainId, workspace: path.resolve(ctx.workspace) });
  const connectionRef = await connectionRefFor(ctx, kind);
  if (kind === 'nebula') {
    return new NebulaBackend({
      brainId: ctx.brainId,
      workspace: path.resolve(ctx.workspace),
      connectionRef,
      space: parseBackendDescriptor(ctx.brain?.backend)?.space,
    });
  }
  return new PgBackend({
    brainId: ctx.brainId,
    workspace: path.resolve(ctx.workspace),
    connectionRef,
    database: parseBackendDescriptor(ctx.brain?.backend)?.database,
  });
}
