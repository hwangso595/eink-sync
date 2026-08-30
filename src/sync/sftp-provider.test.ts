/**
 * Tests for SftpProvider -- specifically that the underlying engine's success
 * flag is propagated through the SyncProvider adapter (previously it was
 * dropped, so a failed transfer looked like a success to callers).
 */

import { SftpProvider } from './sftp-provider';
import { SftpSyncEngine } from './sftp-sync';
import { connectSftp } from './sftp-connection';

jest.mock('./sftp-sync');
jest.mock('./sftp-connection');

const config = {
  host: 'host',
  port: 22,
  username: 'root',
  password: '',
  timeoutMs: 1000,
  connectionMethod: 'usb' as const,
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

  it('passes the selected connection method into the transfer engine', async () => {
    mockEngine({
      success: true,
      filesDownloaded: 0,
      filesSkipped: 0,
      bytesDownloaded: 0,
      durationMs: 0,
      errors: [],
      summary: 'Nothing changed',
    });
    await new SftpProvider(config).sync();
    expect(SftpSyncEngine).toHaveBeenCalledWith(
      expect.objectContaining({ connectionMethod: 'usb' }),
    );
  });
});

describe('SftpProvider.isAvailable', () => {
  it('opens the actual SFTP subsystem and closes the connection', async () => {
    const end = jest.fn();
    (connectSftp as jest.Mock).mockResolvedValue({ conn: { end }, sftp: {} });

    await expect(new SftpProvider(config).isAvailable()).resolves.toBe(true);
    expect(connectSftp).toHaveBeenCalledWith(expect.objectContaining({
      host: 'host',
      connectionMethod: 'usb',
    }));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('returns false when SSH works but the SFTP subsystem cannot open', async () => {
    (connectSftp as jest.Mock).mockRejectedValue(new Error('SFTP subsystem unavailable'));
    await expect(new SftpProvider(config).isAvailable()).resolves.toBe(false);
  });
});
