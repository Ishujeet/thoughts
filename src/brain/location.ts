/**
 * Bundle-relative path classification (specs/01 "Brain layout").
 *
 * Kept in its own module so `okf.ts` and `walk.ts` can use it without
 * importing `layout.ts` (which imports `generate.ts`, which imports them).
 * `layout.ts` re-exports `locate` as the contract name.
 */
import { GENERATED_FILENAMES, ZONES, type ThoughtLocation, type Zone } from '../types.js';

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-/;

/** Normalise a bundle-relative path to a leading-slash form with `/` separators. */
export function normalizeBundlePath(relPath: string): string {
  let p = relPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * True for the generated codegraph data of a repo, `repos/<id>/codegraph/**`
 * (specs/17 "Storage"): never a thought, never scanned, never indexed.
 */
export function isCodegraphPath(relPath: string): boolean {
  const p = normalizeBundlePath(relPath).slice(1).split('/');
  return p.length >= 3 && p[0] === 'repos' && p[2] === 'codegraph';
}

/**
 * Locate a bundle-relative path inside the three zones. Returns `undefined`
 * for paths outside `shared/`, `repos/`, `users/`, for zone/owner directories
 * themselves, for the generated `index.md` / `log.md` files, and for a repo's
 * generated `codegraph/` data (specs/17: generated data, never hand-edited).
 */
export function locate(relPath: string): ThoughtLocation | undefined {
  const path = normalizeBundlePath(relPath);
  const segments = path.slice(1).split('/');
  if (segments.length < 2) return undefined;
  const zone = segments[0] as Zone;
  if (!ZONES.includes(zone)) return undefined;
  const filename = segments[segments.length - 1] as string;
  if (GENERATED_FILENAMES.includes(filename)) return undefined;

  let owner: string | undefined;
  let rest: string[];
  if (zone === 'shared') {
    rest = segments.slice(1);
  } else {
    if (segments.length < 3) return undefined;
    owner = segments[1] as string;
    rest = segments.slice(2);
  }
  if (rest.length === 0 || (rest[rest.length - 1] as string).length === 0) return undefined;
  if (rest[0] === 'codegraph') return undefined;

  const kind = rest.length >= 2 ? rest[0] : undefined;
  const m = DATE_PREFIX.exec(filename);
  const location: ThoughtLocation = { path, zone };
  if (owner !== undefined) location.owner = owner;
  if (kind !== undefined) location.kind = kind;
  if (m) location.date = m[1] as string;
  return location;
}

/** The `repo` frontmatter value a location implies: `shared`, `<repo-id>`, or `user:<id>`. */
export function expectedRepoField(location: ThoughtLocation): string {
  if (location.zone === 'shared') return 'shared';
  if (location.zone === 'users') return 'user:' + (location.owner ?? '');
  return location.owner ?? '';
}
