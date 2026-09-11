// Supervisor-owned smoke test: proves the scaffold wiring (ESM, vitest, assets).
import { describe, expect, it } from 'vitest';
import { cliVersion, packageRoot } from '../src/assets.js';
import { handleError } from '../src/cli.js';
import { ExitCode, SecretFoundError, ThoughtsError } from '../src/types.js';

describe('scaffold', () => {
  it('locates the package root and version', () => {
    expect(packageRoot()).toMatch(/\/workspace$|thoughts$|[\\/]/);
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('maps ThoughtsError to its exit code', () => {
    expect(handleError(new ThoughtsError('x', ExitCode.NotInitialised))).toBe(5);
    expect(handleError(new SecretFoundError([]))).toBe(7);
    expect(handleError(new Error('boom'))).toBe(1);
  });
});
