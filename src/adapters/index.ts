/** Adapter registry (specs/11). Milestone 1 ships claude-code only. */
import { claudeCode, type Adapter } from './claude-code.js';

export type { Adapter, KitFileReport, InstallOptions } from './claude-code.js';

/** Every tool name the specs know about; only the ones in ADAPTERS are implemented. */
export const KNOWN_TOOLS: readonly string[] = ['claude-code', 'codex', 'pi'];

export const ADAPTERS: Readonly<Record<string, Adapter>> = {
  'claude-code': claudeCode,
  // TODO(milestone 2): codex and pi adapters (specs/11).
};

export function getAdapter(name: string): Adapter | undefined {
  return ADAPTERS[name];
}

export function detectAdapters(repoRoot: string): string[] {
  return Object.values(ADAPTERS)
    .filter((a) => a.detect(repoRoot))
    .map((a) => a.name());
}
