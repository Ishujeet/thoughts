/** The BrainBackend contract against the in-memory reference backend. */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe } from 'vitest';
import { InMemoryBackend, InMemoryStore } from '../../../src/brain/backends/memory.js';
import { DEFAULT_KINDS, type BrainConfig } from '../../../src/types.js';
import { cleanupMachines, makeMachine } from '../../commands/helpers.js';
import { backendContract, type BackendFixture } from './checklist.js';

afterEach(async () => {
  await cleanupMachines();
});

describe('BrainBackend contract: memory', () => {
  backendContract('memory', async (): Promise<BackendFixture> => {
    const machine = await makeMachine('mem');
    const store = new InMemoryStore();
    let peers = 0;
    const workspace = (): string => {
      const dir = path.join(machine.root, 'ws-' + peers);
      peers += 1;
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const brain: BrainConfig = {
      okf_version: '0.2',
      kind: 'project',
      name: 'contract-brain',
      repos: [],
      kinds: { ...DEFAULT_KINDS },
      templates: { source: 'builtin' },
    };
    return {
      backend: new InMemoryBackend({ brainId: 'contract-brain', workspace: workspace(), store }),
      peer: async () => new InMemoryBackend({ brainId: 'contract-brain', workspace: workspace(), store }),
      brain,
    };
  });
});
