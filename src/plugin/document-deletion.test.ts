import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SSHExecutor } from '../ssh/ssh-client';
import {
  archiveLocalDocumentCopies,
  deleteDocumentFromTablet,
  deleteLocalDocumentCopies,
} from './document-deletion';

const UUID = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

function mockSsh(
  results: Array<{ stdout: string; stderr: string; exitCode: number }>,
): SSHExecutor {
  return {
    connect: jest.fn(),
    disconnect: jest.fn(),
    ping: jest.fn(),
    isConnected: jest.fn(),
    execute: jest.fn().mockImplementation(() => Promise.resolve(results.shift())),
  } as unknown as SSHExecutor;
}

describe('archiveLocalDocumentCopies', () => {
  it('keeps the latest document in Archive and removes it from Sync', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-archive-test-'));
    const syncDir = path.join(root, 'Sync');
    const archiveDir = path.join(root, 'Archive');
    fs.mkdirSync(syncDir);
    fs.mkdirSync(archiveDir);

    fs.writeFileSync(path.join(syncDir, `${UUID}.metadata`), 'latest');
    fs.writeFileSync(path.join(syncDir, `${UUID}.pdf`), '%PDF');
    fs.writeFileSync(path.join(archiveDir, `${UUID}.metadata`), 'stale');
    fs.writeFileSync(path.join(syncDir, 'keep.metadata'), '{}');

    expect(archiveLocalDocumentCopies(UUID, syncDir, archiveDir)).toBe(2);
    expect(fs.readdirSync(syncDir)).toEqual(['keep.metadata']);
    expect(fs.readFileSync(path.join(archiveDir, `${UUID}.metadata`), 'utf-8')).toBe('latest');
    expect(fs.existsSync(path.join(archiveDir, `${UUID}.pdf`))).toBe(true);
  });

  it('refuses to use the Sync folder as Archive', () => {
    expect(() => archiveLocalDocumentCopies(UUID, '/tmp/same', '/tmp/same'))
      .toThrow('must be different');
  });
});

describe('deleteLocalDocumentCopies', () => {
  it('deletes matching entries from Sync and Archive only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'document-delete-test-'));
    const syncDir = path.join(root, 'Sync');
    const archiveDir = path.join(root, 'Archive');
    fs.mkdirSync(syncDir);
    fs.mkdirSync(archiveDir);

    fs.writeFileSync(path.join(syncDir, `${UUID}.metadata`), '{}');
    fs.mkdirSync(path.join(syncDir, UUID));
    fs.writeFileSync(path.join(archiveDir, `${UUID}.content`), '{}');
    fs.writeFileSync(path.join(archiveDir, `${UUID}.pdf`), '%PDF');
    fs.writeFileSync(path.join(archiveDir, 'keep.metadata'), '{}');

    expect(deleteLocalDocumentCopies(UUID, [syncDir, archiveDir, archiveDir])).toBe(4);
    expect(fs.readdirSync(syncDir)).toEqual([]);
    expect(fs.readdirSync(archiveDir)).toEqual(['keep.metadata']);
  });

  it('rejects an invalid UUID before touching local folders', () => {
    expect(() => deleteLocalDocumentCopies(`${UUID}*`, ['/tmp']))
      .toThrow('invalid UUID');
  });
});

describe('deleteDocumentFromTablet', () => {
  it('removes the document and every UUID sidecar, then verifies deletion', async () => {
    const ssh = mockSsh([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
    ]);

    await deleteDocumentFromTablet(ssh, UUID);

    expect(ssh.execute).toHaveBeenCalledTimes(2);
    expect(ssh.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining(`rm -rf ${UUID} ${UUID}.*`),
    );
    expect(ssh.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(`for entry in ${UUID} ${UUID}.*`),
    );
  });

  it('rejects an invalid UUID without running a tablet command', async () => {
    const ssh = mockSsh([]);

    await expect(deleteDocumentFromTablet(ssh, `${UUID}; reboot`))
      .rejects.toThrow('invalid UUID');
    expect(ssh.execute).not.toHaveBeenCalled();
  });

  it('fails when the tablet rejects the removal', async () => {
    const ssh = mockSsh([
      { stdout: '', stderr: 'Read-only file system', exitCode: 1 },
    ]);

    await expect(deleteDocumentFromTablet(ssh, UUID))
      .rejects.toThrow('Read-only file system');
    expect(ssh.execute).toHaveBeenCalledTimes(1);
  });

  it('fails when matching tablet entries remain after removal', async () => {
    const ssh = mockSsh([
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 1 },
    ]);

    await expect(deleteDocumentFromTablet(ssh, UUID))
      .rejects.toThrow('could not be verified');
  });
});
