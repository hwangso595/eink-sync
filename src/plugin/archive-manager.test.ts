/**
 * Tests for the archive safety gate: a tablet document must never be deleted
 * unless a non-empty local backup of its files exists in the sync folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  archiveOldDocuments,
  hasLocalBackup,
  markLocalBackupForRefresh,
  tabletFilesBackedUpLocally,
} from './archive-manager';
import type { SSHExecutor } from '../ssh/ssh-client';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
}

function write(dir: string, name: string, content = 'data'): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

function mockSsh(stdout: string, exitCode = 0): SSHExecutor {
  return {
    connect: jest.fn(),
    disconnect: jest.fn(),
    ping: jest.fn(),
    isConnected: jest.fn(),
    execute: jest.fn().mockResolvedValue({ stdout, stderr: '', exitCode }),
  } as unknown as SSHExecutor;
}

describe('hasLocalBackup', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

  it('confirms a PDF document with metadata + content + pdf', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, '%PDF-1.4');
    expect(hasLocalBackup(dir, uuid)).toBe(true);
  });

  it('confirms a notebook backed up by a non-empty annotation directory', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    fs.mkdirSync(path.join(dir, uuid));
    write(path.join(dir, uuid), 'page-1.rm');
    expect(hasLocalBackup(dir, uuid)).toBe(true);
  });

  it('refuses a notebook whose annotation dir holds only an empty stroke file (torn sync)', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    fs.mkdirSync(path.join(dir, uuid));
    write(path.join(dir, uuid), 'page-1.rm', '');
    expect(hasLocalBackup(dir, uuid)).toBe(false);
  });

  it('refuses when the content sidecar is missing (unflushed doc)', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.pdf`, '%PDF');
    expect(hasLocalBackup(dir, uuid)).toBe(false);
  });

  it('refuses when sidecars exist but the document body is absent', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    // No pdf/epub and no annotation dir -> not safely backed up.
    expect(hasLocalBackup(dir, uuid)).toBe(false);
  });

  it('refuses when a required file exists but is empty (torn sync)', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`, '');
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, '%PDF');
    expect(hasLocalBackup(dir, uuid)).toBe(false);
  });

  it('refuses when the annotation dir exists but is empty', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    fs.mkdirSync(path.join(dir, uuid));
    expect(hasLocalBackup(dir, uuid)).toBe(false);
  });

  it('refuses when nothing is synced for the uuid', () => {
    expect(hasLocalBackup(tmpDir(), uuid)).toBe(false);
  });
});

describe('markLocalBackupForRefresh', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

  it('makes existing sidecars stale without changing their contents', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`, 'metadata');
    write(dir, `${uuid}.content`, 'content');

    markLocalBackupForRefresh(dir, uuid);

    expect(fs.readFileSync(path.join(dir, `${uuid}.metadata`), 'utf-8')).toBe('metadata');
    expect(fs.readFileSync(path.join(dir, `${uuid}.content`), 'utf-8')).toBe('content');
    expect(fs.statSync(path.join(dir, `${uuid}.metadata`)).mtimeMs).toBeLessThan(1000);
    expect(fs.statSync(path.join(dir, `${uuid}.content`)).mtimeMs).toBeLessThan(1000);
  });

  it('does not create missing sidecars', () => {
    const dir = tmpDir();
    markLocalBackupForRefresh(dir, uuid);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('tabletFilesBackedUpLocally', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';
  // find output is "<size> <path>" per line (stat -c '%s %n').

  it('refuses when a tablet file (e.g. an annotation) is missing locally', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'PDFDATA'); // 7 bytes; only the PDF is synced locally
    const ssh = mockSsh(`7 ./${uuid}.pdf\n5 ./${uuid}/page-1.rm\n`);
    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(false);
  });

  it('accepts when every tablet file is backed up locally at the same size', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'PDFDATA'); // 7 bytes
    fs.mkdirSync(path.join(dir, uuid));
    write(path.join(dir, uuid), 'page-1.rm', 'RM'); // 2 bytes
    const ssh = mockSsh(`7 ./${uuid}.pdf\n2 ./${uuid}/page-1.rm\n`);
    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(true);
  });

  it('refuses when the local copy is truncated (size mismatch)', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'PDFDATA'); // 7 bytes locally
    const ssh = mockSsh(`9999 ./${uuid}.pdf\n`); // tablet is larger
    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(false);
  });

  it('refuses when the tablet listing fails', async () => {
    expect(await tabletFilesBackedUpLocally(mockSsh('', 1), tmpDir(), uuid)).toBe(false);
  });

  it('allows SFTP-regenerable sidecars to be omitted from backup verification', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    const ssh = mockSsh(`7 ./${uuid}.pdf\n`);

    expect(await tabletFilesBackedUpLocally(
      ssh,
      dir,
      uuid,
      { allowSftpSkippedFiles: true },
    )).toBe(true);
    expect(ssh.execute).toHaveBeenCalledWith(expect.stringContaining(`${uuid}.pagedata`));
    expect(ssh.execute).toHaveBeenCalledWith(expect.stringContaining(`${uuid}.highlights/*`));
  });
});

describe('archiveOldDocuments sync-method verification', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

  function archiveSsh(
    dfOutput = '/dev/mmcblk1p7 6685 669 5678 10% /home\n',
  ): SSHExecutor {
    return {
      connect: jest.fn(),
      disconnect: jest.fn(),
      ping: jest.fn(),
      isConnected: jest.fn(),
      execute: jest.fn().mockImplementation(async (command: string) => {
        if (command.startsWith('df ')) {
          return { stdout: dfOutput, stderr: '', exitCode: 0 };
        }
        if (command.includes("-name '*.metadata'")) {
          return {
            stdout: `/home/root/.local/share/remarkable/xochitl/${uuid}.metadata\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.startsWith('cat ')) {
          return {
            stdout: JSON.stringify({ lastOpened: '1', lastModified: '1', createdTime: '1' }),
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes("stat -c '%s %n'")) {
          const skippedFilesExcluded = command.includes(`./${uuid}.local`);
          return {
            stdout: skippedFilesExcluded
              ? `7 ./${uuid}.pdf\n`
              : `7 ./${uuid}.pdf\n5 ./${uuid}.local\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as SSHExecutor;
  }

  it('archives an SFTP backup without requiring intentionally skipped files', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    const ssh = archiveSsh();

    const count = await archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
      allowSftpSkippedFiles: true,
    });

    expect(count).toBe(1);
    expect(ssh.execute).toHaveBeenCalledWith(expect.stringContaining(`${uuid}.local`));
  });

  it('archives when df wraps a long filesystem name to the previous line', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    const ssh = archiveSsh([
      'Filesystem           1K-blocks      Used Available Use% Mounted on',
      '/dev/mapper/remarkable-userdata-with-a-long-source-name',
      '                         47430      3656     43260   8% /home',
    ].join('\n'));

    const count = await archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
      allowSftpSkippedFiles: true,
    });

    expect(count).toBe(1);
    expect(ssh.execute).toHaveBeenCalledWith('df /home');
  });
});
