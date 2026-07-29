import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SSHExecutor } from '../ssh/ssh-client';
import {
  archiveLocalDocumentCopies,
  deleteGeneratedDocumentArtifacts,
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

describe('deleteGeneratedDocumentArtifacts', () => {
  const OTHER_UUID = '73d2d6c2-9b39-4f07-8cda-194440dbdfb7';

  it('deletes the UUID-matched note, drawing variants, and render cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-delete-test-'));
    const highlightsDir = path.join(root, 'Highlights');
    const drawingsDir = path.join(highlightsDir, 'drawings');
    fs.mkdirSync(drawingsDir, { recursive: true });

    fs.writeFileSync(
      path.join(highlightsDir, 'Renamed note.md'),
      `---\nremarkable_uuid: ${UUID}\n---\n`,
    );
    fs.writeFileSync(
      path.join(highlightsDir, 'Other.md'),
      `---\nremarkable_uuid: ${OTHER_UUID}\n---\n`,
    );
    for (const filename of [
      'Renamed note_p1_abcd.png',
      'Original name_p2.png',
      'Original name_p3_beef.png.bak',
      `.render-cache-${UUID}.json`,
      'Other_p1_abcd.png',
    ]) {
      fs.writeFileSync(path.join(drawingsDir, filename), 'generated');
    }

    expect(deleteGeneratedDocumentArtifacts(
      UUID,
      'Original name',
      [highlightsDir],
      drawingsDir,
    )).toBe(5);
    expect(fs.readdirSync(highlightsDir).sort()).toEqual(['Other.md', 'drawings']);
    expect(fs.readdirSync(drawingsDir)).toEqual(['Other_p1_abcd.png']);
  });

  it('finds a note in a source-specific highlights subfolder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-source-delete-test-'));
    const highlightsDir = path.join(root, 'Highlights');
    const sourceDir = path.join(highlightsDir, 'Tablet A');
    const drawingsDir = path.join(highlightsDir, 'drawings');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(drawingsDir);
    fs.writeFileSync(
      path.join(sourceDir, 'Notebook.md'),
      `---\nremarkable_uuid: ${UUID}\n---\n`,
    );
    fs.writeFileSync(path.join(drawingsDir, 'Notebook_p1_1234.png'), 'generated');

    expect(deleteGeneratedDocumentArtifacts(
      UUID,
      'Notebook',
      [highlightsDir, sourceDir],
      drawingsDir,
    )).toBe(2);
    expect(fs.readdirSync(sourceDir)).toEqual([]);
    expect(fs.readdirSync(drawingsDir)).toEqual([]);
  });

  it('preserves a same-named note and drawings owned by another document', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-collision-delete-test-'));
    const highlightsDir = path.join(root, 'Highlights');
    const drawingsDir = path.join(highlightsDir, 'drawings');
    fs.mkdirSync(drawingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(highlightsDir, 'Shared name.md'),
      `---\nremarkable_uuid: ${OTHER_UUID}\n---\n`,
    );
    fs.writeFileSync(path.join(drawingsDir, 'Shared name_p1_abcd.png'), 'other');

    expect(deleteGeneratedDocumentArtifacts(
      UUID,
      'Shared name',
      [highlightsDir],
      drawingsDir,
    )).toBe(0);
    expect(fs.existsSync(path.join(highlightsDir, 'Shared name.md'))).toBe(true);
    expect(fs.existsSync(path.join(drawingsDir, 'Shared name_p1_abcd.png'))).toBe(true);
  });

  it('rejects an invalid UUID before touching generated files', () => {
    expect(() => deleteGeneratedDocumentArtifacts(
      `${UUID}*`,
      'Document',
      ['/tmp'],
      '/tmp',
    )).toThrow('invalid UUID');
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
