/** The BrainBackend contract against GitBackend over a local bare remote. */
import path from 'node:path';
import { afterEach, describe } from 'vitest';
import { GitBackend } from '../../../src/brain/backends/git.js';
import { loadBrainConfig } from '../../../src/brain/config.js';
import * as git from '../../../src/git.js';
import { cleanupMachines, makeBareBrain, makeMachine } from '../../commands/helpers.js';
import { backendContract, type BackendFixture } from './checklist.js';

afterEach(async () => {
  await cleanupMachines();
});

describe('BrainBackend contract: git', () => {
  backendContract('git', async (): Promise<BackendFixture> => {
    const host = await makeMachine('host');
    const bare = await makeBareBrain(host.root, 'contract-brain');
    const machine = await makeMachine('a');
    let peers = 0;
    const clone = async (): Promise<string> => {
      const dir = path.join(machine.root, 'clone-' + peers);
      peers += 1;
      await git.clone(bare, dir);
      return dir;
    };
    const root = await clone();
    return {
      backend: new GitBackend({ brainId: 'contract-brain', workspace: root }),
      peer: async () => new GitBackend({ brainId: 'contract-brain', workspace: await clone() }),
      brain: await loadBrainConfig(root),
    };
  });
});
