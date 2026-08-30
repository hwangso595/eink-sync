/**
 * Shared rules for identifying and safely materialising a reMarkable document
 * collection. A collection consists of the exact UUID entry plus any UUID.*
 * sidecars introduced by current or future firmware.
 */

import { isValidUuid } from '../plugin/uuid-validation';

const UUID_LENGTH = 36;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_UNSAFE_CHARACTERS = /[<>:"|?*\\]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Return the owning document UUID for an exact UUID or UUID.* entry. */
export function documentUuidForCollectionEntry(entryName: string): string | null {
  if (typeof entryName !== 'string' || entryName.length < UUID_LENGTH) return null;

  const uuid = entryName.slice(0, UUID_LENGTH);
  if (!isValidUuid(uuid)) return null;
  if (entryName.length !== UUID_LENGTH && entryName[UUID_LENGTH] !== '.') return null;
  return uuid.toLowerCase();
}

/**
 * Validate one remote filename before mapping it onto the local filesystem.
 * Linux permits names that become traversal or device paths on Windows, so
 * fail closed rather than writing a document outside its sync directory.
 */
export function assertSafeRemotePathSegment(segment: string): void {
  if (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes('/')
    || CONTROL_CHARACTERS.test(segment)
    || WINDOWS_UNSAFE_CHARACTERS.test(segment)
    || segment.endsWith('.')
    || segment.endsWith(' ')
    || WINDOWS_RESERVED_NAME.test(segment)
  ) {
    throw new Error(`Unsafe tablet entry name: ${JSON.stringify(segment)}`);
  }
}

/**
 * Normalize and validate a POSIX path emitted relative to xochitl. The first
 * component must belong to exactly the requested UUID collection.
 */
export function normalizeDocumentRelativePath(uuid: string, value: string): string {
  if (!isValidUuid(uuid)) throw new Error('Invalid document UUID.');
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value) || value.includes('\\')) {
    throw new Error('Unsafe tablet document path.');
  }

  const relative = value.replace(/^\.\//, '');
  if (!relative || relative.startsWith('/') || relative.endsWith('/')) {
    throw new Error('Unsafe tablet document path.');
  }

  const parts = relative.split('/');
  for (const part of parts) assertSafeRemotePathSegment(part);

  const owner = documentUuidForCollectionEntry(parts[0]);
  if (owner !== uuid.toLowerCase()) {
    throw new Error('Tablet entry does not belong to the requested document.');
  }
  return parts.join('/');
}

/** Return the depth used to delete children before their parent directories. */
export function collectionPathDepth(relativePath: string): number {
  return relativePath.split('/').length;
}
