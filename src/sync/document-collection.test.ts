import {
  assertSafeRemotePathSegment,
  documentUuidForCollectionEntry,
  normalizeDocumentRelativePath,
} from './document-collection';

const UUID = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

describe('document collection policy', () => {
  it('recognises only the exact UUID and UUID.* namespace', () => {
    expect(documentUuidForCollectionEntry(UUID)).toBe(UUID);
    expect(documentUuidForCollectionEntry(`${UUID}.metadata`)).toBe(UUID);
    expect(documentUuidForCollectionEntry(`${UUID}.future-sidecar`)).toBe(UUID);
    expect(documentUuidForCollectionEntry(`${UUID}suffix`)).toBeNull();
    expect(documentUuidForCollectionEntry('not-a-uuid.metadata')).toBeNull();
  });

  it('accepts safe deep paths belonging to the document', () => {
    expect(normalizeDocumentRelativePath(
      UUID,
      `./${UUID}.assets/a/b/c/zero-byte.bin`,
    )).toBe(`${UUID}.assets/a/b/c/zero-byte.bin`);
  });

  it.each(['.', '..', 'a/b', 'a\\b', 'bad\nname', 'NUL', 'file:stream']) (
    'rejects unsafe local path segment %p',
    (segment) => expect(() => assertSafeRemotePathSegment(segment)).toThrow('Unsafe'),
  );

  it('rejects traversal and another document namespace', () => {
    expect(() => normalizeDocumentRelativePath(UUID, `./${UUID}/../secret`)).toThrow('Unsafe');
    expect(() => normalizeDocumentRelativePath(
      UUID,
      './73d2d6c2-9b39-4f07-8cda-194440dbdfb7.metadata',
    )).toThrow('does not belong');
  });
});
