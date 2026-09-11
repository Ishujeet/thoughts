/**
 * Embedded assets (built-in templates under `<package>/templates/`, standard
 * kit under `<package>/kit/`). Supervisor-owned.
 *
 * Assets are plain files shipped next to `dist/`; they are located relative to
 * this module at runtime so the same code works from `src/` (vitest) and
 * `dist/` (built CLI). Never read assets with a cwd-relative path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/** Directory containing package.json for this CLI. */
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('thoughts: cannot locate package root from ' + import.meta.url);
}

/** Absolute path of an asset, e.g. `assetPath('templates', 'plan.md')`. */
export function assetPath(...segments: string[]): string {
  return path.join(packageRoot(), ...segments);
}

/** Read a UTF-8 asset. Throws if missing. */
export function readAsset(...segments: string[]): string {
  return fs.readFileSync(assetPath(...segments), 'utf8');
}

export function assetExists(...segments: string[]): boolean {
  return fs.existsSync(assetPath(...segments));
}

/** CLI version from package.json. Also the kit version (specs/08 "Versioning"). */
export function cliVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(assetPath('package.json'), 'utf8')) as { version: string };
  return pkg.version;
}
