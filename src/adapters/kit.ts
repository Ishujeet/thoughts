/**
 * Standard kit source (specs/08 "Source of the kit"):
 *   1. `<brain>/standard/` when present (org override),
 *   2. else the CLI's embedded `kit/`.
 *
 * Kit files carry a first-line version comment `<!-- thoughts-kit v<version> -->`
 * so adapters can compare installed copies with the current kit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { assetExists, assetPath, readAsset } from '../assets.js';
import { renderTemplate } from '../templates/render.js';

export const KIT_VERSION_RE = /^<!--\s*thoughts-kit\s+v([0-9A-Za-z.+-]+)\s*-->/;

export const KIT_COMMAND_NAMES: readonly string[] = [
  'thoughts-plan',
  'thoughts-spec',
  'thoughts-research',
  'thoughts-decide',
  'thoughts-commit',
  'thoughts-pr',
  'thoughts-status',
  'thoughts-sync',
];

export interface KitVars {
  brain_name: string;
  repo_id: string;
  kit_version: string;
  [key: string]: unknown;
}

/** Raw (unrendered) kit file: `<brain>/standard/<rel>` if it exists, else the embedded asset. */
export function readKitSource(brainRoot: string | undefined, ...segments: string[]): { content: string; path: string } {
  if (brainRoot) {
    const override = path.join(brainRoot, 'standard', ...segments);
    if (fs.existsSync(override)) return { content: fs.readFileSync(override, 'utf8'), path: override };
  }
  if (!assetExists('kit', ...segments)) {
    throw new Error('missing embedded kit asset: kit/' + segments.join('/'));
  }
  return { content: readAsset('kit', ...segments), path: assetPath('kit', ...segments) };
}

/** Rendered kit file with `{{brain_name}}`, `{{repo_id}}`, `{{kit_version}}` substituted. */
export function renderKitFile(brainRoot: string | undefined, vars: KitVars, ...segments: string[]): string {
  const src = readKitSource(brainRoot, ...segments);
  const { output } = renderTemplate(src.content, vars, { templatePath: src.path });
  return output.endsWith('\n') ? output : output + '\n';
}

/** Rendered managed-block body for the instruction file (specs/08 section 1). */
export function renderInstructions(brainRoot: string | undefined, vars: KitVars): string {
  return renderKitFile(brainRoot, vars, 'instructions.md').replace(/\n+$/, '');
}

/** Version from the first line, or undefined when the file has no kit comment. */
export function kitFileVersion(content: string): string | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const m = KIT_VERSION_RE.exec(firstLine);
  return m ? m[1] : undefined;
}

/** -1 when a < b, 0 equal, 1 when a > b; numeric dot-separated compare, pre-release ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[-+]/)[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
