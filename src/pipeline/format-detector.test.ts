import { detectRmFormat, isFormatSupported, getParserForFormat, detectRmFormatFromFile } from './format-detector';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('detectRmFormat', () => {
  it('detects v6 format', () => {
    const header = Buffer.from('reMarkable .lines file, version=6          ');
    expect(detectRmFormat(header)).toBe('v6');
  });

  it('detects v5 format', () => {
    const header = Buffer.from('reMarkable .lines file, version=5          ');
    expect(detectRmFormat(header)).toBe('v5');
  });

  it('detects v3 format', () => {
    const header = Buffer.from('reMarkable .lines file, version=3          ');
    expect(detectRmFormat(header)).toBe('v3');
  });

  it('returns unknown for unrecognized headers', () => {
    const header = Buffer.from('some random binary content here');
    expect(detectRmFormat(header)).toBe('unknown');
  });

  it('returns unknown for empty buffer', () => {
    const header = Buffer.alloc(0);
    expect(detectRmFormat(header)).toBe('unknown');
  });
});

describe('isFormatSupported', () => {
  it('supports v6, v5, and v3', () => {
    expect(isFormatSupported('v6')).toBe(true);
    expect(isFormatSupported('v5')).toBe(true);
    expect(isFormatSupported('v3')).toBe(true);
  });

  it('does not support unknown', () => {
    expect(isFormatSupported('unknown')).toBe(false);
  });
});

describe('getParserForFormat', () => {
  it('returns rmscene for v6', () => {
    expect(getParserForFormat('v6')).toBe('rmscene');
  });

  it('returns legacy for v3 and v5', () => {
    expect(getParserForFormat('v3')).toBe('legacy');
    expect(getParserForFormat('v5')).toBe('legacy');
  });

  it('returns null for unknown', () => {
    expect(getParserForFormat('unknown')).toBeNull();
  });
});

describe('detectRmFormatFromFile', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects v6 from a file', async () => {
    const filePath = path.join(tmpDir, 'test-v6.rm');
    const header = Buffer.from('reMarkable .lines file, version=6          ');
    fs.writeFileSync(filePath, header);
    expect(await detectRmFormatFromFile(filePath)).toBe('v6');
  });

  it('detects v5 from a file', async () => {
    const filePath = path.join(tmpDir, 'test-v5.rm');
    const header = Buffer.from('reMarkable .lines file, version=5          ');
    fs.writeFileSync(filePath, header);
    expect(await detectRmFormatFromFile(filePath)).toBe('v5');
  });

  it('detects v3 from a file', async () => {
    const filePath = path.join(tmpDir, 'test-v3.rm');
    const header = Buffer.from('reMarkable .lines file, version=3          ');
    fs.writeFileSync(filePath, header);
    expect(await detectRmFormatFromFile(filePath)).toBe('v3');
  });

  it('returns unknown for nonexistent file', async () => {
    expect(await detectRmFormatFromFile('/nonexistent/path.rm')).toBe('unknown');
  });

  it('returns unknown for binary garbage', async () => {
    const filePath = path.join(tmpDir, 'test-garbage.rm');
    fs.writeFileSync(filePath, Buffer.alloc(64, 0xff));
    expect(await detectRmFormatFromFile(filePath)).toBe('unknown');
  });
});
