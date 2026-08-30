import type { SSHExecutor } from '../ssh/ssh-client';
import { TabletDocumentAdapter } from './tablet-document-adapter';
import type {
  SftpUploadOptions,
  SftpUploadProgressCallback,
} from './sftp-upload';

const UUID = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';
const ssh = {} as SSHExecutor;

function createHarness() {
  const operations: string[] = [];
  const upload = jest.fn(async (
    _options: SftpUploadOptions,
    _uuid: string,
    _onProgress?: SftpUploadProgressCallback,
  ) => {
    operations.push('upload');
    return { filesUploaded: 3, bytesUploaded: 100 };
  });
  const deleteRemote = jest.fn(async () => {
    operations.push('delete-remote');
  });
  const archiveRemote = jest.fn(async (
    _ssh: SSHExecutor,
    localSyncDir: string,
    _uuid: string,
  ) => {
    operations.push(`archive-remote:${localSyncDir}`);
  });
  const unprotectRemote = jest.fn(async () => {
    operations.push('unprotect-remote');
  });
  const protectRemote = jest.fn(async () => {
    operations.push('protect-remote');
    return { uuid: UUID, addedLines: [`/${UUID}`, `/${UUID}.*`] };
  });
  const refresh = jest.fn(async () => {
    operations.push('refresh');
    return true;
  });
  const withSSH = async <T>(fn: (executor: SSHExecutor) => Promise<T>): Promise<T> => {
    operations.push('connect');
    return await fn(ssh);
  };
  const adapter = new TabletDocumentAdapter(
    {
      host: '10.11.99.1',
      port: 22,
      username: 'root',
      password: '',
      timeoutMs: 1000,
      connectionMethod: 'usb',
    },
    withSSH,
    refresh,
    { upload, deleteRemote, archiveRemote, protectRemote, unprotectRemote },
  );
  return {
    adapter,
    operations,
    upload,
    deleteRemote,
    archiveRemote,
    protectRemote,
    unprotectRemote,
    refresh,
  };
}

describe('TabletDocumentAdapter', () => {
  it('sends directly and refreshes the tablet for every sync mode', async () => {
    const { adapter, operations, upload } = createHarness();

    await expect(adapter.sendDocument(UUID, '/vault/Sync')).resolves.toEqual({
      tabletLibraryRefreshed: true,
    });
    expect(operations).toEqual(['upload', 'refresh']);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ connectionMethod: 'usb' }),
      UUID,
      expect.any(Function),
    );
  });

  it('reports connecting, per-file upload, refresh, and completion phases', async () => {
    const { adapter, upload } = createHarness();
    upload.mockImplementationOnce(async (_options, _uuid, onProgress) => {
      onProgress?.(`${UUID}.content`, 1, 2, 25, 100);
      onProgress?.(`${UUID}.metadata`, 2, 2, 100, 100);
      return { filesUploaded: 2, bytesUploaded: 100 };
    });
    const progress = jest.fn();

    await adapter.sendDocument(UUID, '/vault/Sync', progress);

    expect(progress.mock.calls).toEqual([
      ['connecting', 'Connecting to tablet...'],
      ['uploading', `${UUID}.content`, 1, 2, 25],
      ['uploading', `${UUID}.metadata`, 2, 2, 100],
      ['refreshing', 'Refreshing tablet library...'],
      ['complete', 'Upload complete.'],
    ]);
  });

  it('restores locally, uploads, and rolls back when delivery fails', async () => {
    const { adapter, operations, upload } = createHarness();
    upload.mockImplementationOnce(async () => {
      operations.push('upload');
      throw new Error('offline');
    });

    await expect(adapter.restoreDocument(
      UUID,
      '/vault/Sync',
      () => operations.push('restore-local'),
      () => operations.push('rollback-local'),
    )).rejects.toThrow('offline');
    expect(operations).toEqual([
      'restore-local',
      'connect',
      'unprotect-remote',
      'upload',
      'rollback-local',
      'connect',
      'protect-remote',
    ]);
  });

  it('removes exact archive ignore rules before uploading a restore', async () => {
    const { adapter, operations } = createHarness();

    await adapter.restoreDocument(
      UUID,
      '/vault/Sync',
      () => operations.push('restore-local'),
      () => operations.push('rollback-local'),
    );

    expect(operations).toEqual([
      'restore-local',
      'connect',
      'unprotect-remote',
      'upload',
      'refresh',
    ]);
  });

  it('deletes remotely, deletes locally, then refreshes', async () => {
    const { adapter, operations } = createHarness();

    await adapter.deleteDocument(UUID, () => operations.push('delete-local'));
    expect(operations).toEqual([
      'connect',
      'delete-remote',
      'delete-local',
      'refresh',
    ]);
  });

  it('refreshes an already-deleted tablet document when local deletion fails', async () => {
    const { adapter, operations } = createHarness();

    await expect(adapter.deleteDocument(UUID, () => {
      operations.push('delete-local');
      throw new Error('locked');
    })).rejects.toThrow('locked');
    expect(operations).toEqual([
      'connect',
      'delete-remote',
      'delete-local',
      'refresh',
    ]);
  });

  it('verifies the named local backup before archiving remotely', async () => {
    const { adapter, operations } = createHarness();

    await expect(adapter.archiveDocument(
      UUID,
      '/vault/Sync',
      () => operations.push('archive-local'),
    )).resolves.toEqual({ tabletLibraryRefreshed: true });
    expect(operations).toEqual([
      'connect',
      'archive-remote:/vault/Sync',
      'archive-local',
      'refresh',
    ]);
  });

  it('keeps the local copy when remote backup verification fails', async () => {
    const { adapter, operations, archiveRemote } = createHarness();
    archiveRemote.mockRejectedValueOnce(new Error('backup incomplete'));

    await expect(adapter.archiveDocument(
      UUID,
      '/vault/Sync',
      () => operations.push('archive-local'),
    )).rejects.toThrow('backup incomplete');
    expect(operations).toEqual(['connect']);
  });
});
