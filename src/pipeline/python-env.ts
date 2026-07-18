/**
 * Managed Python environment for the extraction scripts.
 *
 * Historically the plugin spawned whatever `python`/`python3` was on PATH and
 * trusted the user to have installed rmscene + PyMuPDF into it. When the PATH
 * interpreter changed (e.g. a new Python install), extraction kept "succeeding"
 * while silently producing empty notes, because the missing import degraded to
 * per-page warnings.
 *
 * This module gives the plugin its own virtual environment, created on demand
 * in a per-machine OS data directory (never inside the vault, so it is never
 * synced between machines) and populated with the pinned runtime packages.
 * `uv` is used when available (fast, can provision Python itself); otherwise
 * it falls back to `python -m venv` + pip.
 *
 * Resolution order for an extraction run:
 *   1. Existing managed env that imports cleanly  -> use it.
 *   2. Create/repair the managed env              -> use it.
 *   3. System Python that already has the deps    -> use it (with a warning).
 *   4. Nothing usable                             -> throw. The caller must
 *      surface this and abort instead of writing empty notes.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';
import { BridgeError, ErrorCode } from '../types/errors';

/** Core runtime packages; import names checked by {@link CORE_IMPORT_CHECK}. */
export const REQUIRED_PACKAGES = ['rmscene>=0.5.0', 'PyMuPDF>=1.23.0'];

/** Optional OCR packages (the Tesseract binary itself cannot be pip-installed). */
export const OCR_PACKAGES = ['pytesseract>=0.3.10', 'Pillow>=10.0.0'];

/** Import statement that must succeed for an environment to be usable. */
const CORE_IMPORT_CHECK = 'import rmscene, fitz';
const OCR_IMPORT_CHECK = 'import pytesseract, PIL';

const VERIFY_TIMEOUT_MS = 20_000;
const CREATE_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 600_000;

/** Result of a child command; never throws (spawn errors map to code -1). */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable command runner so the flow is unit-testable without Python. */
export type CommandRunner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export interface ManagedPythonOptions {
  /** Also install the OCR packages (best-effort; failure is non-fatal). */
  ocrExtras?: boolean;
  /** Override the env directory (tests). Defaults to {@link getManagedEnvDir}. */
  envDir?: string;
  /** User-facing progress messages (the plugin shows these as Notices). */
  onProgress?: (message: string) => void;
  /** Override the command runner (tests). */
  runner?: CommandRunner;
}

export interface ManagedPythonResult {
  /** Python executable to use for this run. */
  pythonPath: string;
  /** True when pythonPath points into the managed env (vs. system fallback). */
  managed: boolean;
  /** True when the env was created or repaired during this call. */
  created: boolean;
}

/**
 * Per-machine data directory for the managed env, outside the vault.
 *
 * The plugin folder itself lives inside the vault and may be synced between
 * machines (this vault runs on two hosts); a venv is machine-specific, so it
 * must live in an OS-local location.
 */
export function getManagedEnvDir(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'eink-sync', 'pyenv');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'eink-sync', 'pyenv');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'eink-sync', 'pyenv');
}

/** Path of the venv's Python executable for the current platform. */
export function getVenvPython(envDir: string): string {
  return process.platform === 'win32'
    ? path.join(envDir, 'Scripts', 'python.exe')
    : path.join(envDir, 'bin', 'python');
}

/** Default runner: spawn without a shell, capture output, resolve always. */
const spawnRunner: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise<CommandResult>((resolve) => {
    try {
      const proc = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
      });
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

/** A spawn timeout closes with code null; say so instead of "exit code null". */
function describeExit(result: CommandResult): string {
  return result.code === null ? 'timed out' : `exit code ${result.code}`;
}

async function verifyImports(
  runner: CommandRunner,
  pythonPath: string,
  importCheck: string = CORE_IMPORT_CHECK,
): Promise<boolean> {
  const result = await runner(pythonPath, ['-c', importCheck], VERIFY_TIMEOUT_MS);
  return result.code === 0;
}

async function detectUv(runner: CommandRunner): Promise<boolean> {
  const result = await runner('uv', ['--version'], 10_000);
  return result.code === 0;
}

/** First PATH interpreter that answers `--version` with a Python 3, or null. */
async function detectSystemPython(runner: CommandRunner): Promise<string | null> {
  for (const candidate of ['python3', 'python']) {
    const result = await runner(candidate, ['--version'], 5_000);
    if (result.code === 0 && result.stdout.includes('Python 3')) {
      return candidate;
    }
  }
  return null;
}

/** Install packages into the venv via uv or pip. Returns stderr on failure. */
async function installPackages(
  runner: CommandRunner,
  useUv: boolean,
  venvPython: string,
  packages: string[],
): Promise<string | null> {
  const result = useUv
    ? await runner('uv', ['pip', 'install', '--python', venvPython, ...packages], INSTALL_TIMEOUT_MS)
    : await runner(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', ...packages], INSTALL_TIMEOUT_MS);
  if (result.code === 0) return null;
  return result.stderr.trim() || describeExit(result);
}

async function createVenv(
  runner: CommandRunner,
  useUv: boolean,
  envDir: string,
): Promise<string | null> {
  if (useUv) {
    const result = await runner('uv', ['venv', envDir], CREATE_TIMEOUT_MS);
    return result.code === 0 ? null : result.stderr.trim() || describeExit(result);
  }
  const systemPython = await detectSystemPython(runner);
  if (!systemPython) {
    return 'no Python 3 on PATH to create a venv with (and uv is not installed)';
  }
  const result = await runner(systemPython, ['-m', 'venv', envDir], CREATE_TIMEOUT_MS);
  return result.code === 0 ? null : result.stderr.trim() || describeExit(result);
}

/** Best-effort OCR extras; missing OCR degrades gracefully downstream. */
async function ensureOcrPackages(
  runner: CommandRunner,
  useUv: boolean,
  venvPython: string,
): Promise<void> {
  if (await verifyImports(runner, venvPython, OCR_IMPORT_CHECK)) return;
  const installError = await installPackages(runner, useUv, venvPython, OCR_PACKAGES);
  if (installError) {
    logger.warn(`Could not install OCR packages into managed env: ${installError}`);
  }
}

/** Minimum wait before re-attempting provisioning after a failed attempt. */
const PROVISION_BACKOFF_MS = 5 * 60_000;

// Module state: concurrent extraction runs (e.g. two file watchers firing in
// the same sync burst) share one provisioning attempt instead of racing to
// create/delete the same env, and a failed attempt is not retried on every
// watcher event.
let inFlight: Promise<ManagedPythonResult> | null = null;
let lastProvisionFailureAt = 0;

/** Test-only: clear the in-flight/backoff module state between test cases. */
export function resetManagedPythonStateForTests(): void {
  inFlight = null;
  lastProvisionFailureAt = 0;
}

/**
 * Ensure a Python interpreter with the required packages and return its path.
 *
 * Concurrent callers share a single provisioning attempt. After a failed
 * attempt, provisioning is skipped for {@link PROVISION_BACKOFF_MS} (the
 * system-Python fallback is still tried) so auto-extract does not churn.
 *
 * @throws BridgeError(PYTHON_DEPS_MISSING) when neither the managed env nor
 *         the system Python can provide the required imports. Callers must
 *         abort the run — proceeding would write empty notes.
 */
export async function ensureManagedPython(
  options: ManagedPythonOptions = {},
): Promise<ManagedPythonResult> {
  if (inFlight) return inFlight;
  const attempt = ensureManagedPythonInner(options);
  inFlight = attempt;
  try {
    return await attempt;
  } finally {
    inFlight = null;
  }
}

async function ensureManagedPythonInner(
  options: ManagedPythonOptions,
): Promise<ManagedPythonResult> {
  const runner = options.runner ?? spawnRunner;
  const envDir = options.envDir ?? getManagedEnvDir();
  const venvPython = getVenvPython(envDir);
  const progress = options.onProgress ?? (() => undefined);
  const failures: string[] = [];

  // 1. Existing healthy env — the fast path for every run after the first.
  //    The check is retried once: a single transient failure (load, spawn
  //    hiccup) must not send a working env into the repair path, which can
  //    end up deleting it.
  if (fs.existsSync(venvPython)) {
    if (await verifyImports(runner, venvPython) || await verifyImports(runner, venvPython)) {
      if (options.ocrExtras) {
        await ensureOcrPackages(runner, await detectUv(runner), venvPython);
      }
      return { pythonPath: venvPython, managed: true, created: false };
    }
    logger.warn(`Managed env at ${envDir} failed the import check; repairing.`);
  }

  // 2. Create or repair the managed env (unless a recent attempt failed).
  if (Date.now() - lastProvisionFailureAt >= PROVISION_BACKOFF_MS) {
    progress('E-Ink Sync: setting up Python environment...');
    const useUv = await detectUv(runner);
    logger.info(`Provisioning managed Python env at ${envDir} (uv: ${useUv})`);

    let repaired = false;
    if (fs.existsSync(venvPython)) {
      // Broken but present: try reinstalling packages before rebuilding.
      const installError = await installPackages(runner, useUv, venvPython, REQUIRED_PACKAGES);
      if (!installError && await verifyImports(runner, venvPython)) {
        repaired = true;
      } else if (installError) {
        failures.push(`repair install: ${installError}`);
      }
    }

    if (!repaired) {
      // Always clear the directory first: a leftover dir without a working
      // interpreter (killed provisioning, dangling symlink after a base
      // Python upgrade) makes `uv venv` fail forever otherwise.
      try {
        fs.rmSync(envDir, { recursive: true, force: true });
      } catch (err) {
        failures.push(`remove stale env: ${err instanceof Error ? err.message : String(err)}`);
      }
      const createError = await createVenv(runner, useUv, envDir);
      if (createError) {
        failures.push(`create venv: ${createError}`);
      } else {
        const installError = await installPackages(runner, useUv, venvPython, REQUIRED_PACKAGES);
        if (installError) failures.push(`install packages: ${installError}`);
      }
    }

    if (fs.existsSync(venvPython) && await verifyImports(runner, venvPython)) {
      if (options.ocrExtras) {
        await ensureOcrPackages(runner, useUv, venvPython);
      }
      lastProvisionFailureAt = 0;
      return { pythonPath: venvPython, managed: true, created: true };
    }
    lastProvisionFailureAt = Date.now();
  } else {
    failures.push('recent provisioning attempt failed; waiting before retrying');
  }

  // 3. Fall back to a system Python that already has the deps, so setups that
  //    worked before this feature keep working even if env creation fails
  //    here. Every PATH candidate is tried, not just the first one that
  //    answers --version.
  let foundSystemPython = false;
  for (const candidate of ['python3', 'python']) {
    const version = await runner(candidate, ['--version'], 5_000);
    if (version.code !== 0 || !version.stdout.includes('Python 3')) continue;
    foundSystemPython = true;
    if (await verifyImports(runner, candidate)) {
      logger.warn(
        `Managed env unavailable (${failures.join('; ') || 'unknown failure'}); ` +
        `falling back to system Python "${candidate}".`,
      );
      return { pythonPath: candidate, managed: false, created: false };
    }
    failures.push(`system Python "${candidate}" is missing required packages`);
  }
  if (!foundSystemPython) {
    failures.push('no Python 3 found on PATH');
  }

  throw new BridgeError(
    ErrorCode.PYTHON_DEPS_MISSING,
    'No usable Python environment for extraction.',
    `Attempts: ${failures.join('; ')}. Install uv (https://docs.astral.sh/uv/) ` +
    `or run "pip install ${REQUIRED_PACKAGES.join(' ')}" with a Python 3.10+ on PATH, ` +
    `then retry.`,
  );
}
