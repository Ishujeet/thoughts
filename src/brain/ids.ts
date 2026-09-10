/**
 * Identifiers that become filesystem path segments (repo id, brain id, user id,
 * kind name). One rule for all of them so that no `.thoughts.yml`, `brain.yml`
 * or remote URL can steer a write outside the brain.
 */
export const ID_HINT = 'use letters, digits, . _ -';

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * True when `id` is a single, opaque path segment: letters, digits, `.`, `_`,
 * `-` only, and neither `.` nor `..`.
 */
export function isValidRepoId(id: string): boolean {
  return ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

/** Replace every character outside the id alphabet with `-`; `''` when nothing valid remains. */
export function sanitiseId(value: string): string {
  const s = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return isValidRepoId(s) ? s : '';
}
