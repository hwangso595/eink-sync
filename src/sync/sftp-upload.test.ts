import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { uploadDocumentCollectionWithSftp } from './sftp-upload';

const UUID = '12345678-1234-4234-8234-123456789abc';
const REMOTE_ROOT = '/home/root/.local/share/remarkable/xochitl';

function missingError(): Error & { code: number } {
  return Object.assign(new Error('No such file'), { code: 2 });
}

function directoryStats(): Stats {
  return { isDirectory: () => true } as Stats;
}

function createMockSftp(operations: string[]): SFTPWrapper {
  const directories = new Set([REMOTE_ROOT]);
  const files = new Set<string>();
  type StatusCallback = (error?: Error) => void;
  type StatCallback = (error: Error | undefined, stats?: Stats) => void;

  return {
    stat(remotePath: string, callback: StatCallback) {
      if (directories.has(remotePath)) callback(undefined, directoryStats());
      else if (files.has(remotePath)) callback(undefined, { isDirectory: () => false } as Stats);
      else callback(missingError());
    },
    mkdir(remotePath: string, _attributes: object, callback: StatusCallback) {
      operations.push(`mkdir:${remotePath}`);
      directories.add(remotePath);
      callback(undefined);
    },
    unlink(remotePath: string, callback: StatusCallback) {
      operations.push(`unlink:${remotePath}`);
      if (files.delete(remotePath)) callback(undefined);
      else callback(missingError());
    },
    fastPut(
      localPath: string,
      remotePath: string,
      optionsOrCallback: { step?: (total: number, chunk: number, size: number) => void }
        | StatusCallback,
      maybeCallback?: StatusCallback,
    ) {
      operations.push(`put:${path.basename(localPath)}:${remotePath}`);
      files.add(remotePath);
      const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
      const callback = typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : maybeCallback!;
      const size = fs.statSync(localPath).size;
      options?.step?.(size, size, size);
      callback(undefined);
    },
    rename(oldPath: string, newPath: string, callback: StatusCallback) {
      operations.push(`rename:${newPath}`);
      files.delete(oldPath);
      files.add(newPath);
      callback(undefined);
    },
  } as unknown as SFTPWrapper;
}

describe('SFTP document upload', () => {
  let localDir: string;

  beforeEach(() => {
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eink-sync-upload-'));
  });

  afterEach(() => {
    fs.rmSync(localDir, { recursive: true, force: true });
  });

  it('uploads a complete UUID collection and commits metadata last', async () => {
    fs.writeFileSync(path.join(localDir, `${UUID}.pdf`), 'pdf');
    fs.writeFileSync(path.join(localDir, `${UUID}.content`), 'content');
    fs.writeFileSync(path.join(localDir, `${UUID}.metadata`), 'metadata');
    fs.mkdirSync(path.join(localDir, UUID));
    fs.writeFileSync(path.join(localDir, UUID, 'page.rm'), 'strokes');

    const operations: string[] = [];
    const result = await uploadDocumentCollectionWithSftp(
      createMockSftp(operations),
      localDir,
      REMOTE_ROOT,
      UUID,
    );

    expect(result).toEqual({
      filesUploaded: 4,
      bytesUploaded: Buffer.byteLength('pdfcontentmetadatastrokes'),
    });
    expect(operations).toContain(`mkdir:${REMOTE_ROOT}/${UUID}`);

    const committedFiles = operations
      .filter((operation) => operation.startsWith('rename:'));
    expect(committedFiles).toHaveLength(4);
    expect(committedFiles.at(-1)).toBe(`rename:${REMOTE_ROOT}/${UUID}.metadata`);
  });

  it('reports each uploaded file in commit order', async () => {
    fs.writeFileSync(path.join(localDir, `${UUID}.pdf`), 'pdf');
    fs.writeFileSync(path.join(localDir, `${UUID}.content`), 'content');
    fs.writeFileSync(path.join(localDir, `${UUID}.metadata`), 'metadata');
    const progress = jest.fn();

    await uploadDocumentCollectionWithSftp(
      createMockSftp([]),
      localDir,
      REMOTE_ROOT,
      UUID,
      progress,
    );

    const totalBytes = Buffer.byteLength('pdfcontentmetadata');
    expect(progress.mock.calls).toEqual([
      [`${UUID}.content`, 1, 3, 0, totalBytes],
      [`${UUID}.content`, 1, 3, Buffer.byteLength('content'), totalBytes],
      [
        `${UUID}.pdf`,
        2,
        3,
        Buffer.byteLength('contentpdf'),
        totalBytes,
      ],
      [
        `${UUID}.metadata`,
        3,
        3,
        totalBytes,
        totalBytes,
      ],
    ]);
  });

  it('rejects invalid UUIDs before touching SFTP', async () => {
    const operations: string[] = [];

    await expect(uploadDocumentCollectionWithSftp(
      createMockSftp(operations),
      localDir,
      REMOTE_ROOT,
      '../not-a-uuid',
    )).rejects.toThrow('invalid UUID');

    expect(operations).toEqual([]);
  });
});
