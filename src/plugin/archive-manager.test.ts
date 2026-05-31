/**
 * Tests for the archive safety gate: a tablet document must never be deleted
 * unless a non-empty local backup of its files exists in the sync folder.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hasLocalBackup } from './archive-manager';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
}

function write(dir: string, name: string, content = 'data'): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
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
