/**
 * Tests for the archive safety gate: a tablet document must never be deleted
 * unless a non-empty local backup of its files exists in the sync folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasLocalBackup, tabletFilesBackedUpLocally } from './archive-manager';
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
});
