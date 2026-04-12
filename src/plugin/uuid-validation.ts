/**
 * UUID validation utility for safe shell command construction.
 *
 * All UUIDs used in shell commands (rm, echo, etc.) must pass this
 * validation to prevent shell injection from malformed .metadata files.
 *
 * Privacy: Pure validation logic, no network or filesystem access.
 */

/** Strict UUID v4 pattern: 8-4-4-4-12 hex characters with dashes. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a string is a well-formed UUID.
 *
 * Returns true only for standard 8-4-4-4-12 hex UUIDs.
 * Rejects empty strings, strings with shell metacharacters, and
 * any string that does not match the UUID format exactly.
 */
export function isValidUuid(uuid: string): boolean {
  if (!uuid || typeof uuid !== 'string') return false;
  return UUID_PATTERN.test(uuid);
}
