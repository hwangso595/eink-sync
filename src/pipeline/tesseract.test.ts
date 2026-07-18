/**
 * Tests for Tesseract engine detection and installation.
 *
 * The command runner is injected, so nothing here spawns a package manager.
 */

import {
  getInstallCommand,
  describeInstallCommand,
  getTesseractStatus,
  installTesseract,
} from './tesseract';
import type { CommandRunner } from './python-env';

/** Runner that records its calls and replays canned results. */
function fakeRunner(
  result: { code: number | null; stdout?: string; stderr?: string },
): { runner: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { runner, calls };
}

const STATUS_AVAILABLE = JSON.stringify({
  available: true,
  pytesseract_installed: true,
  pillow_installed: true,
  tesseract_binary_found: true,
  tesseract_version: '5.3.0',
  error: null,
});

const STATUS_NO_BINARY = JSON.stringify({
  available: false,
  pytesseract_installed: true,
  pillow_installed: true,
  tesseract_binary_found: false,
  tesseract_version: null,
  error: 'Tesseract binary not found',
});

describe('getInstallCommand', () => {
  it('installs the UB-Mannheim build unattended on Windows', () => {
    const command = getInstallCommand('win32');
    expect(command).toMatchObject({ cmd: 'winget', manager: 'winget', automatable: true });
    expect(command?.args).toEqual(expect.arrayContaining(['UB-Mannheim.TesseractOCR', '--silent']));
  });

  it('uses Homebrew on macOS', () => {
    expect(getInstallCommand('darwin')).toMatchObject({ cmd: 'brew', automatable: true });
  });

  it('marks Linux non-automatable because apt needs sudo', () => {
    expect(getInstallCommand('linux')).toMatchObject({ cmd: 'sudo', automatable: false });
  });

  it('returns null for platforms with no known package manager', () => {
    expect(getInstallCommand('aix')).toBeNull();
    expect(describeInstallCommand('aix')).toBeNull();
  });

  it('describes the command as a copy-pasteable string', () => {
    expect(describeInstallCommand('darwin')).toBe('brew install tesseract');
  });
});

describe('getTesseractStatus', () => {
  it('reports an available engine with its version', async () => {
    const { runner, calls } = fakeRunner({ code: 0, stdout: STATUS_AVAILABLE });
    const status = await getTesseractStatus('/py', '/scripts/ocr_engine.py', runner);

    expect(status).toMatchObject({ available: true, binaryFound: true, version: '5.3.0' });
    expect(calls[0]).toEqual({ cmd: '/py', args: ['/scripts/ocr_engine.py', '--status'] });
  });

  it('distinguishes a missing binary from missing Python packages', async () => {
    const { runner } = fakeRunner({ code: 0, stdout: STATUS_NO_BINARY });
    const status = await getTesseractStatus('/py', '/scripts/ocr_engine.py', runner);

    expect(status.available).toBe(false);
    expect(status.binaryFound).toBe(false);
    expect(status.pytesseractInstalled).toBe(true);
    expect(status.error).toContain('not found');
  });

  it('treats a failed probe as unavailable rather than throwing', async () => {
    const { runner } = fakeRunner({ code: 1, stderr: 'ModuleNotFoundError: ocr_engine' });
    const status = await getTesseractStatus('/py', '/scripts/ocr_engine.py', runner);

    expect(status.available).toBe(false);
    expect(status.error).toContain('ModuleNotFoundError');
  });

  it('treats unparseable output as unavailable', async () => {
    const { runner } = fakeRunner({ code: 0, stdout: 'not json at all' });
    const status = await getTesseractStatus('/py', '/scripts/ocr_engine.py', runner);

    expect(status.available).toBe(false);
    expect(status.error).toContain('parse');
  });
});

describe('installTesseract', () => {
  it('runs the platform install command and reports success', async () => {
    const { runner, calls } = fakeRunner({ code: 0 });
    const progress: string[] = [];
    const result = await installTesseract({
      platform: 'win32',
      runner,
      onProgress: (m) => progress.push(m),
    });

    expect(result.success).toBe(true);
    expect(calls[0].cmd).toBe('winget');
    expect(progress[0]).toContain('winget');
  });

  it('does not run sudo unattended, returning the command to run instead', async () => {
    const { runner, calls } = fakeRunner({ code: 0 });
    const result = await installTesseract({ platform: 'linux', runner });

    expect(result.success).toBe(false);
    expect(result.message).toContain('sudo apt-get install -y tesseract-ocr');
    expect(calls).toHaveLength(0);
  });

  it('explains a missing package manager instead of surfacing ENOENT', async () => {
    const { runner } = fakeRunner({ code: -1, stderr: 'Error: spawn winget ENOENT' });
    const result = await installTesseract({ platform: 'win32', runner });

    expect(result.success).toBe(false);
    expect(result.message).toContain('winget was not found');
  });

  it('reports a non-zero exit with the tail of the output', async () => {
    const { runner } = fakeRunner({ code: 1, stderr: 'No package found matching input criteria.' });
    const result = await installTesseract({ platform: 'win32', runner });

    expect(result.success).toBe(false);
    expect(result.message).toContain('exit code 1');
    expect(result.message).toContain('No package found');
  });

  it('reports a timeout as a timeout, not "exit code null"', async () => {
    const { runner } = fakeRunner({ code: null, stderr: '' });
    const result = await installTesseract({ platform: 'win32', runner });

    expect(result.success).toBe(false);
    expect(result.message).toContain('timed out');
  });

  it('refuses unsupported platforms without spawning anything', async () => {
    const { runner, calls } = fakeRunner({ code: 0 });
    const result = await installTesseract({ platform: 'aix', runner });

    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
