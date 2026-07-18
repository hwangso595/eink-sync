/**
 * Tesseract OCR engine detection and installation.
 *
 * `pytesseract` is only a wrapper: the OCR engine itself is a native binary
 * that pip/uv cannot provide, so a managed Python env with the OCR packages
 * still yields no OCR. Previously the only signal was silently missing text
 * in notes; this module lets the settings tab report the binary's status and
 * install it through the platform's package manager.
 *
 * Installation is delegated to the user's package manager (winget/brew/apt)
 * rather than downloading binaries ourselves: no unsigned payloads, and the
 * engine stays upgradable through the channel it came from.
 */

import { spawn } from 'child_process';
import { logger } from '../utils/logger';
import type { CommandRunner } from './python-env';

/** How long a package-manager install may run before we give up on it. */
const INSTALL_TIMEOUT_MS = 600_000;
const STATUS_TIMEOUT_MS = 20_000;

/** What `ocr_engine.py --status` reports about this machine. */
export interface TesseractStatus {
  /** True only when pytesseract, Pillow, and the binary are all usable. */
  available: boolean;
  pytesseractInstalled: boolean;
  pillowInstalled: boolean;
  binaryFound: boolean;
  version: string | null;
  /** Human-readable reason when unavailable. */
  error: string | null;
}

/** A package-manager command that installs Tesseract on this platform. */
export interface InstallCommand {
  cmd: string;
  args: string[];
  /** Package manager name, for user-facing messages. */
  manager: string;
  /** True when we can run it unattended (no sudo/user interaction needed). */
  automatable: boolean;
}

/** Default runner: spawn without a shell, capture output, never reject. */
const spawnRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ code, stdout, stderr }));
      proc.on('error', (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err) });
    }
  });

/**
 * The install command for a platform, or null where we cannot install
 * unattended (Linux needs sudo, so the UI shows the command instead).
 *
 * Windows uses the UB-Mannheim build — the de-facto standard Windows
 * distribution, and the one whose install path `ocr_engine.py` probes.
 */
export function getInstallCommand(platform: NodeJS.Platform = process.platform): InstallCommand | null {
  if (platform === 'win32') {
    return {
      cmd: 'winget',
      args: [
        'install', '--id', 'UB-Mannheim.TesseractOCR', '-e',
        '--silent', '--accept-package-agreements', '--accept-source-agreements',
      ],
      manager: 'winget',
      automatable: true,
    };
  }
  if (platform === 'darwin') {
    return { cmd: 'brew', args: ['install', 'tesseract'], manager: 'Homebrew', automatable: true };
  }
  if (platform === 'linux') {
    return {
      cmd: 'sudo',
      args: ['apt-get', 'install', '-y', 'tesseract-ocr'],
      manager: 'apt',
      automatable: false,
    };
  }
  return null;
}

/** Copy-pasteable install command for the settings UI. */
export function describeInstallCommand(platform: NodeJS.Platform = process.platform): string | null {
  const command = getInstallCommand(platform);
  return command ? `${command.cmd} ${command.args.join(' ')}` : null;
}

/**
 * Ask the extraction scripts whether OCR is usable, via
 * `python ocr_engine.py --status`.
 *
 * Reports the failure as an unavailable status rather than throwing: this
 * drives a settings label, and a probe failure is itself a valid "not
 * available" answer.
 */
export async function getTesseractStatus(
  pythonPath: string,
  ocrEnginePath: string,
  runner: CommandRunner = spawnRunner,
): Promise<TesseractStatus> {
  const unavailable = (error: string): TesseractStatus => ({
    available: false,
    pytesseractInstalled: false,
    pillowInstalled: false,
    binaryFound: false,
    version: null,
    error,
  });

  const result = await runner(pythonPath, [ocrEnginePath, '--status'], STATUS_TIMEOUT_MS);
  if (result.code !== 0) {
    return unavailable(result.stderr.trim() || `Status check failed (exit ${result.code}).`);
  }

  try {
    const raw = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    return {
      available: raw.available === true,
      pytesseractInstalled: raw.pytesseract_installed === true,
      pillowInstalled: raw.pillow_installed === true,
      binaryFound: raw.tesseract_binary_found === true,
      version: typeof raw.tesseract_version === 'string' ? raw.tesseract_version : null,
      error: typeof raw.error === 'string' ? raw.error : null,
    };
  } catch {
    return unavailable('Could not parse the OCR status report.');
  }
}

export interface InstallTesseractOptions {
  platform?: NodeJS.Platform;
  runner?: CommandRunner;
  /** User-facing progress messages (the plugin shows these as Notices). */
  onProgress?: (message: string) => void;
}

export interface InstallTesseractResult {
  success: boolean;
  /** User-facing outcome, suitable for a Notice. */
  message: string;
}

/**
 * Install the Tesseract binary through the platform package manager.
 *
 * Never throws: the caller is a settings button, and every failure mode here
 * (no package manager, non-zero exit, unsupported platform) is something the
 * user should read rather than a crash. A successful install does not require
 * a PATH refresh — `ocr_engine.py` probes the standard install locations, so
 * OCR works in the already-running Obsidian process.
 */
export async function installTesseract(
  options: InstallTesseractOptions = {},
): Promise<InstallTesseractResult> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? spawnRunner;
  const progress = options.onProgress ?? (() => {});

  const command = getInstallCommand(platform);
  if (!command) {
    return { success: false, message: `Automatic install is not supported on ${platform}.` };
  }
  if (!command.automatable) {
    return {
      success: false,
      message: `Run this in a terminal (it needs administrator rights): ${command.cmd} ${command.args.join(' ')}`,
    };
  }

  progress(`Installing Tesseract via ${command.manager} — this can take a few minutes...`);
  logger.info(`Installing Tesseract: ${command.cmd} ${command.args.join(' ')}`);

  const result = await runner(command.cmd, command.args, INSTALL_TIMEOUT_MS);

  if (result.code === 0) {
    return { success: true, message: 'Tesseract installed. Handwriting OCR is ready.' };
  }

  // A missing package manager surfaces as a spawn error, not a tool exit.
  if (result.code === -1 && /ENOENT/.test(result.stderr)) {
    return {
      success: false,
      message: `${command.manager} was not found on this computer. Install Tesseract manually: `
        + `${command.cmd} ${command.args.join(' ')}`,
    };
  }

  const detail = (result.stderr.trim() || result.stdout.trim() || '').split('\n').slice(-3).join(' ');
  const reason = result.code === null ? 'timed out' : `exit code ${result.code}`;
  logger.warn(`Tesseract install failed (${reason}): ${detail}`);
  return { success: false, message: `Tesseract install failed (${reason}). ${detail}`.trim() };
}
