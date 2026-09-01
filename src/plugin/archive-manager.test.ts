/**
 * Tests for the archive safety gate: a tablet document must never be deleted
 * unless a non-empty local backup of its files exists in the sync folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  archiveOldDocuments,
  archiveVerifiedTabletDocument,
  hasLocalBackup,
  parseDfUsagePercent,
  protectDocumentFromResync,
  readTabletDocumentManifest,
  tabletFilesBackedUpLocally,
  unprotectDocumentFromResync,
} from './archive-manager';
import type { SSHExecutor } from '../ssh/ssh-client';
import { logger } from '../utils/logger';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
}

function write(dir: string, name: string, content = 'data'): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function manifestFile(relativePath: string, content: string, mtime = 1): string {
  return `f\t${Buffer.byteLength(content)}\t${mtime}\t${sha256(content)}\t./${relativePath}\n`;
}

function manifestDirectory(relativePath: string, mtime = 1): string {
  return `d\t0\t${mtime}\t-\t./${relativePath}\n`;
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

function dfOutput(usagePercent: number, wrapped = false): string {
  const header = 'Filesystem 1K-blocks Used Available Use% Mounted on\n';
  const row = `47430 3656 43260 ${usagePercent}% /home\n`;
  return wrapped ? `${header}/dev/mapper/a-very-long-filesystem-name\n ${row}` : `${header}/dev/root ${row}`;
}

describe('parseDfUsagePercent', () => {
  it('parses normal and wrapped rows by their Use% column', () => {
    expect(parseDfUsagePercent(dfOutput(8))).toBe(8);
    expect(parseDfUsagePercent(dfOutput(83, true))).toBe(83);
  });

  it('rejects failed shapes and percentages outside 0..100', () => {
    expect(parseDfUsagePercent('')).toBeNull();
    expect(parseDfUsagePercent('47430 3656 43260 nope /home')).toBeNull();
    expect(parseDfUsagePercent('47430 3656 43260 101% /home')).toBeNull();
  });
});

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

  it('confirms a notebook whose page data is nested by newer firmware', () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    const nested = path.join(dir, uuid, 'pages', 'assets');
    fs.mkdirSync(nested, { recursive: true });
    write(nested, 'page-1.rm');
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

describe('tabletFilesBackedUpLocally', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';
  // Manifest output is "<kind>\t<size>\t<mtime>\t<sha256>\t<path>" per line.

  it('refuses when a tablet file (e.g. an annotation) is missing locally', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'PDFDATA'); // 7 bytes; only the PDF is synced locally
    const ssh = mockSsh(
      manifestFile(`${uuid}.pdf`, 'PDFDATA', 1700000000) +
      manifestFile(`${uuid}/page-1.rm`, '12345', 1700000000),
    );
    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(false);
  });

  it('accepts when every tablet file is backed up locally at the same size', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'PDFDATA'); // 7 bytes
    fs.mkdirSync(path.join(dir, uuid));
    write(path.join(dir, uuid), 'page-1.rm', 'RM'); // 2 bytes
    const ssh = mockSsh(
      manifestFile(`${uuid}.pdf`, 'PDFDATA', 1700000000) +
      manifestDirectory(uuid, 1700000000) +
      manifestFile(`${uuid}/page-1.rm`, 'RM', 1700000000),
    );
    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(true);
  });

  it('refuses when the local copy is truncated (size mismatch)', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'PDFDATA'); // 7 bytes locally
    const ssh = mockSsh(manifestFile(`${uuid}.pdf`, 'x'.repeat(9999), 1700000000));
    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(false);
  });

  it('refuses a same-size stale file whose SHA-256 differs', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.pdf`, 'LOCAL');
    const ssh = mockSsh(manifestFile(`${uuid}.pdf`, 'OTHER'));
    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(false);
  });

  it('refuses when the tablet listing fails', async () => {
    expect(await tabletFilesBackedUpLocally(mockSsh('', 1), tmpDir(), uuid)).toBe(false);
  });

  it('requires unknown, zero-byte, and deeply nested entries', async () => {
    const dir = tmpDir();
    const assets = path.join(dir, `${uuid}.assets`, 'a', 'b', 'c');
    fs.mkdirSync(assets, { recursive: true });
    write(assets, 'empty.bin', '');
    const ssh = mockSsh(
      manifestDirectory(`${uuid}.assets`) +
      manifestDirectory(`${uuid}.assets/a`) +
      manifestDirectory(`${uuid}.assets/a/b`) +
      manifestDirectory(`${uuid}.assets/a/b/c`) +
      manifestFile(`${uuid}.assets/a/b/c/empty.bin`, ''),
    );

    expect(await tabletFilesBackedUpLocally(ssh, dir, uuid)).toBe(true);
  });

  it('rejects symlinks and traversal paths from the tablet manifest', async () => {
    const symlink = mockSsh(`l\t0\t0\t-\t./${uuid}.assets\n`);
    await expect(readTabletDocumentManifest(symlink, uuid)).rejects.toThrow('Unsupported');

    const traversal = mockSsh(
      `f\t4\t1\t${sha256('data')}\t./${uuid}/../secret\n`,
    );
    await expect(readTabletDocumentManifest(traversal, uuid)).rejects.toThrow('Unsafe');

    const hashFailure = mockSsh(`e\t0\t0\t-\t./${uuid}.content\n`);
    await expect(readTabletDocumentManifest(hashFailure, uuid))
      .rejects.toThrow('invalid entry type');
  });
});

describe('archive ignore protection', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

  it('adds root-anchored UUID and UUID.* rules without a broad UUID* rule', async () => {
    const ssh = mockSsh(`/${uuid}\n/${uuid}.*\n`);
    const result = await protectDocumentFromResync(ssh, uuid);

    expect(result.addedLines).toEqual([`/${uuid}`, `/${uuid}.*`]);
    const command = (ssh.execute as jest.Mock).mock.calls[0][0] as string;
    expect(command).toContain(`grep -Fqx '/${uuid}'`);
    expect(command).toContain(`grep -Fqx '/${uuid}.*'`);
    expect(command).not.toContain(`grep -Fqx '${uuid}*'`);
  });

  it('removes exact current and legacy archive rules before restore', async () => {
    const ssh = mockSsh('');
    await unprotectDocumentFromResync(ssh, uuid);

    const command = (ssh.execute as jest.Mock).mock.calls[0][0] as string;
    expect(command).toContain(`$0 != "/${uuid}"`);
    expect(command).toContain(`$0 != "/${uuid}.*"`);
    expect(command).toContain(`$0 != "${uuid}*"`);
  });

  it('rolls back only newly-added rules when the manifest changes before deletion', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    const manifest =
      manifestFile(`${uuid}.metadata`, 'data') +
      manifestFile(`${uuid}.content`, 'data') +
      manifestFile(`${uuid}.pdf`, 'PDFDATA');
    const changedManifest =
      manifestFile(`${uuid}.metadata`, 'data') +
      manifestFile(`${uuid}.content`, 'changed') +
      manifestFile(`${uuid}.pdf`, 'PDFDATA');
    const commands: string[] = [];
    const responses = [
      { stdout: manifest, stderr: '', exitCode: 0 },
      { stdout: `/${uuid}.*\n`, stderr: '', exitCode: 0 },
      { stdout: changedManifest, stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
    ];
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn(async (command: string) => {
        commands.push(command);
        return responses.shift()!;
      }),
    } as unknown as SSHExecutor;

    await expect(archiveVerifiedTabletDocument(ssh, dir, uuid))
      .rejects.toThrow('changed during archive');
    expect(commands[1]).toContain('grep -Fqx');
    expect(commands.some((command) => command.includes(`rm -f './${uuid}.`))).toBe(false);
    expect(commands[3]).toContain(`$0 != "/${uuid}.*"`);
    expect(commands[3]).not.toContain(`$0 != "/${uuid}"`);
    expect(commands[3]).toContain('cmp -s');
  });

  it('keeps new ignore rules when post-delete verification finds a partial collection', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    const manifest =
      manifestFile(`${uuid}.metadata`, 'data') +
      manifestFile(`${uuid}.content`, 'data') +
      manifestFile(`${uuid}.pdf`, 'PDFDATA');
    const partial = manifestFile(`${uuid}.metadata`, 'data');
    const commands: string[] = [];
    const responses = [
      { stdout: manifest, stderr: '', exitCode: 0 },
      { stdout: `/${uuid}\n/${uuid}.*\n`, stderr: '', exitCode: 0 },
      { stdout: manifest, stderr: '', exitCode: 0 },
      { stdout: '', stderr: '', exitCode: 0 },
      { stdout: partial, stderr: '', exitCode: 0 },
    ];
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn(async (command: string) => {
        commands.push(command);
        return responses.shift()!;
      }),
    } as unknown as SSHExecutor;

    await expect(archiveVerifiedTabletDocument(ssh, dir, uuid))
      .rejects.toThrow('deletion could not be verified');
    expect(commands.some((command) => command.includes(`rm -f './${uuid}.pdf'`))).toBe(true);
    expect(commands.some((command) => command.includes('cmp -s'))).toBe(false);
  });
});

describe('archiveOldDocuments sync-method verification', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

  const completeManifest =
    manifestFile(`${uuid}.metadata`, 'data') +
    manifestFile(`${uuid}.content`, 'data') +
    manifestFile(`${uuid}.pdf`, 'PDFDATA') +
    manifestFile(`${uuid}.future`, '');

  function archiveSsh(options: {
    failDelete?: boolean;
    extraTabletFile?: boolean;
    recheckUsage?: number;
  } = {}): SSHExecutor {
    let manifestReads = 0;
    let dfReads = 0;
    return {
      connect: jest.fn(),
      disconnect: jest.fn(),
      ping: jest.fn(),
      isConnected: jest.fn(),
      execute: jest.fn().mockImplementation(async (command: string) => {
        if (command.startsWith('df ')) {
          dfReads++;
          const usage = dfReads > 1 && options.recheckUsage !== undefined
            ? options.recheckUsage
            : 90;
          return { stdout: dfOutput(usage, true), stderr: '', exitCode: 0 };
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
        if (command.includes('for root in')) {
          manifestReads++;
          return {
            stdout: manifestReads <= 2
              ? completeManifest + (options.extraTabletFile
                ? manifestFile(`${uuid}.unknown`, 'new')
                : '')
              : '',
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('grep -Fqx')) {
          return {
            stdout: `/${uuid}\n/${uuid}.*\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        if (command.includes('rm -f')) {
          return options.failDelete
            ? { stdout: '', stderr: 'checksum mismatch', exitCode: 1 }
            : { stdout: '', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as SSHExecutor;
  }

  it('parses a wrapped initial df row and skips below the threshold', async () => {
    const dir = tmpDir();
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn().mockResolvedValue({ stdout: dfOutput(8, true), stderr: '', exitCode: 0 }),
    } as unknown as SSHExecutor;

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: false,
      localSyncDir: dir,
    })).resolves.toBe(0);
    expect(ssh.execute).toHaveBeenCalledTimes(1);
    expect(ssh.execute).toHaveBeenCalledWith('df /home');
  });

  it('does not trust df output from a failed command', async () => {
    const dir = tmpDir();
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn().mockResolvedValue({ stdout: dfOutput(99), stderr: 'df failed', exitCode: 1 }),
    } as unknown as SSHExecutor;

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: false,
      localSyncDir: dir,
    })).resolves.toBe(0);
    expect(ssh.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects unexpected metadata paths before constructing a shell command', async () => {
    const dir = tmpDir();
    const maliciousPath =
      '/home/root/.local/share/remarkable/xochitl/$(touch /tmp/archive-pwned).metadata';
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn(async (command: string) => {
        if (command.startsWith('df ')) {
          return { stdout: dfOutput(90), stderr: '', exitCode: 0 };
        }
        if (command.includes("-name '*.metadata'")) {
          return { stdout: `${maliciousPath}\n`, stderr: '', exitCode: 0 };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    } as unknown as SSHExecutor;

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
    })).resolves.toBe(0);

    expect(ssh.execute).toHaveBeenCalledTimes(2);
    expect(ssh.execute).not.toHaveBeenCalledWith(expect.stringContaining('touch'));
  });

  it('parses a wrapped recheck row after a verified deletion', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    write(dir, `${uuid}.future`, '');
    const ssh = archiveSsh({ recheckUsage: 70 });

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: false,
      localSyncDir: dir,
    })).resolves.toBe(1);
    const dfCalls = (ssh.execute as jest.Mock).mock.calls
      .map((call) => call[0] as string)
      .filter((command) => command === 'df /home');
    expect(dfCalls).toHaveLength(2);
  });

  it('archives every verified sidecar and reports success only after absence is verified', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    write(dir, `${uuid}.future`, '');
    const ssh = archiveSsh();

    const count = await archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
    });

    expect(count).toBe(1);
    expect(ssh.execute).toHaveBeenCalledWith(expect.stringContaining(`${uuid}.future`));
    expect(ssh.execute).not.toHaveBeenCalledWith(expect.stringContaining('rm -rf'));
  });

  it('does not delete or count a document with an unfamiliar file missing locally', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    write(dir, `${uuid}.future`, '');
    const ssh = archiveSsh({ extraTabletFile: true });

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
    })).resolves.toBe(0);
    expect(ssh.execute).not.toHaveBeenCalledWith(expect.stringContaining('rm -f'));
  });

  it('throws when every actual archive attempt fails', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    write(dir, `${uuid}.future`, '');
    const ssh = archiveSsh({ failDelete: true });
    const restart = jest.fn();

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
    }, restart)).rejects.toThrow(
      `Could not archive any eligible documents: ${uuid}: ` +
      'Tablet rejected archive deletion: checksum mismatch',
    );
    expect(restart).not.toHaveBeenCalled();
    const deleteCommand = (ssh.execute as jest.Mock).mock.calls
      .map((call) => call[0] as string)
      .find((command) => command.includes('rm -f'));
    expect(deleteCommand).toContain(sha256('PDFDATA'));
    expect(ssh.execute).not.toHaveBeenCalledWith(expect.stringContaining('cmp -s'));
  });

  it('returns zero when an eligible document has no local backup', async () => {
    const dir = tmpDir();
    const ssh = archiveSsh();

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
    })).resolves.toBe(0);
    expect(ssh.execute).not.toHaveBeenCalledWith(expect.stringContaining('for root in'));
    expect(ssh.execute).not.toHaveBeenCalledWith(expect.stringContaining('rm -f'));
  });

  it('requests one refresh when a later document fails after an earlier deletion', async () => {
    const secondUuid = '73d2d6c2-9b39-4f07-8cda-194440dbdfb7';
    const dir = tmpDir();
    for (const id of [uuid, secondUuid]) {
      write(dir, `${id}.metadata`);
      write(dir, `${id}.content`);
      write(dir, `${id}.pdf`, 'PDFDATA');
    }
    const firstManifest =
      manifestFile(`${uuid}.metadata`, 'data') +
      manifestFile(`${uuid}.content`, 'data') +
      manifestFile(`${uuid}.pdf`, 'PDFDATA');
    let firstReads = 0;
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn(async (command: string) => {
        if (command.startsWith('df ')) return { stdout: dfOutput(90, true), stderr: '', exitCode: 0 };
        if (command.includes("-name '*.metadata'")) {
          return {
            stdout:
              `/home/root/.local/share/remarkable/xochitl/${uuid}.metadata\n` +
              `/home/root/.local/share/remarkable/xochitl/${secondUuid}.metadata\n`,
            stderr: '', exitCode: 0,
          };
        }
        if (command.startsWith('cat ')) {
          return {
            stdout: JSON.stringify({ lastOpened: '1', lastModified: '1', createdTime: '1' }),
            stderr: '', exitCode: 0,
          };
        }
        if (command.includes(`for root in './${uuid}'`)) {
          firstReads++;
          return { stdout: firstReads <= 2 ? firstManifest : '', stderr: '', exitCode: 0 };
        }
        if (command.includes(`for root in './${secondUuid}'`)) {
          return { stdout: '', stderr: 'inventory failed', exitCode: 1 };
        }
        if (command.includes('grep -Fqx')) {
          return { stdout: `/${uuid}\n/${uuid}.*\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as SSHExecutor;
    const restart = jest.fn();

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
    }, restart)).resolves.toBe(1);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('continues after one document fails and returns only later successes', async () => {
    const secondUuid = '73d2d6c2-9b39-4f07-8cda-194440dbdfb7';
    const dir = tmpDir();
    for (const id of [uuid, secondUuid]) {
      write(dir, `${id}.metadata`);
      write(dir, `${id}.content`);
      write(dir, `${id}.pdf`, 'PDFDATA');
    }
    const secondManifest =
      manifestFile(`${secondUuid}.metadata`, 'data') +
      manifestFile(`${secondUuid}.content`, 'data') +
      manifestFile(`${secondUuid}.pdf`, 'PDFDATA');
    let secondReads = 0;
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn(async (command: string) => {
        if (command.startsWith('df ')) return { stdout: dfOutput(90), stderr: '', exitCode: 0 };
        if (command.includes("-name '*.metadata'")) {
          return {
            stdout:
              `/home/root/.local/share/remarkable/xochitl/${uuid}.metadata\n` +
              `/home/root/.local/share/remarkable/xochitl/${secondUuid}.metadata\n`,
            stderr: '', exitCode: 0,
          };
        }
        if (command.startsWith('cat ')) {
          return {
            stdout: JSON.stringify({ lastOpened: '1', lastModified: '1', createdTime: '1' }),
            stderr: '', exitCode: 0,
          };
        }
        if (command.includes(`for root in './${uuid}'`)) {
          return { stdout: '', stderr: 'inventory failed', exitCode: 1 };
        }
        if (command.includes(`for root in './${secondUuid}'`)) {
          secondReads++;
          return { stdout: secondReads <= 2 ? secondManifest : '', stderr: '', exitCode: 0 };
        }
        if (command.includes('grep -Fqx')) {
          return { stdout: `/${secondUuid}\n/${secondUuid}.*\n`, stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      }),
    } as unknown as SSHExecutor;
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(archiveOldDocuments(ssh, {
      thresholdPercent: 80,
      minAgeDays: 1,
      force: true,
      localSyncDir: dir,
    })).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`${uuid}: Could not inventory`));
    expect(ssh.execute).toHaveBeenCalledWith(expect.stringContaining(`${secondUuid}.pdf`));
    error.mockRestore();
  });
});

describe('manual verified archive helper', () => {
  const uuid = '7449b8ee-c9dc-4fc0-b9a1-9a743952c4e1';

  it('refuses deletion when a deep tablet file is not present locally', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    const ssh = mockSsh(
      manifestFile(`${uuid}.metadata`, 'data') +
      manifestFile(`${uuid}.content`, 'data') +
      manifestFile(`${uuid}.pdf`, 'PDFDATA') +
      manifestFile(`${uuid}.assets/a/b/c/new.bin`, 'new'),
    );

    await expect(archiveVerifiedTabletDocument(ssh, dir, uuid))
      .rejects.toThrow('not completely backed up');
    expect(ssh.execute).toHaveBeenCalledTimes(1);
  });

  it('idempotently archives an already-absent collection with a valid local backup', async () => {
    const dir = tmpDir();
    write(dir, `${uuid}.metadata`);
    write(dir, `${uuid}.content`);
    write(dir, `${uuid}.pdf`, 'PDFDATA');
    const ssh = {
      connect: jest.fn(), disconnect: jest.fn(), ping: jest.fn(), isConnected: jest.fn(),
      execute: jest.fn(async (command: string) => ({
        stdout: command.includes('grep -Fqx') ? `/${uuid}\n/${uuid}.*\n` : '',
        stderr: '',
        exitCode: 0,
      })),
    } as unknown as SSHExecutor;

    await expect(archiveVerifiedTabletDocument(ssh, dir, uuid)).resolves.toBeUndefined();
    expect(ssh.execute).toHaveBeenCalledWith(expect.stringContaining('grep -Fqx'));
    expect(ssh.execute).not.toHaveBeenCalledWith(expect.stringContaining('rm -f'));
  });
});
