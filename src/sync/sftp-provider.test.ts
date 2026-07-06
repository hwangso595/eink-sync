/**
 * Tests for SftpProvider -- specifically that the underlying engine's success
 * flag is propagated through the SyncProvider adapter (previously it was
 * dropped, so a failed transfer looked like a success to callers).
 */

import { SftpProvider } from './sftp-provider';
import { SftpSyncEngine } from './sftp-sync';

jest.mock('./sftp-sync');

const config = {
  host: 'host',
  port: 22,
  username: 'root',
  password: '',
  timeoutMs: 1000,
  localSyncDir: '/tmp/sync',
  includeEpub: false,
};

function mockEngine(result: unknown) {
  (SftpSyncEngine as jest.Mock).mockImplementation(() => ({
    sync: async () => result,
  }));
}

describe('SftpProvider.sync', () => {
  it('propagates a failed transfer (success:false) to the SyncResult', async () => {
    mockEngine({
      success: false,
      filesDownloaded: 0,
      filesSkipped: 0,
      bytesDownloaded: 0,
      durationMs: 0,
      errors: ['connection refused'],
      summary: 'SFTP sync failed',
    });
    const result = await new SftpProvider(config).sync();
    expect(result.success).toBe(false);
    expect(result.errors).toContain('connection refused');
  });

  it('propagates a successful transfer with its counts', async () => {
    mockEngine({
      success: true,
      filesDownloaded: 3,
      filesSkipped: 1,
      bytesDownloaded: 1024,
      durationMs: 50,
      errors: [],
      summary: 'Downloaded 3 file(s)',
    });
    const result = await new SftpProvider(config).sync();
    expect(result.success).toBe(true);
    expect(result.filesDownloaded).toBe(3);
    expect(result.filesSkipped).toBe(1);
  });
});
