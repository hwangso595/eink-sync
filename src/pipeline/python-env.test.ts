/**
 * Tests for python-env.ts — managed Python environment provisioning.
 *
 * The command runner is injected so no real Python/uv is required. Venv
 * existence is simulated with real temp directories because the module
 * checks fs.existsSync on the venv interpreter.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureManagedPython,
  getManagedEnvDir,
  getVenvPython,
  resetManagedPythonStateForTests,
  REQUIRED_PACKAGES,
  type CommandResult,
} from './python-env';
import { BridgeError, ErrorCode } from '../types/errors';

const ok: CommandResult = { code: 0, stdout: '', stderr: '' };
const fail: CommandResult = { code: 1, stdout: '', stderr: 'boom' };

/** Records calls and answers them via a matcher function. */
function makeRunner(
  answer: (cmd: string, args: string[]) => CommandResult,
) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner = async (cmd: string, args: string[]): Promise<CommandResult> => {
    calls.push({ cmd, args });
    return answer(cmd, args);
  };
  return { runner, calls };
}

function makeTempEnvDir(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyenv-test-')), 'pyenv');
}

/** Create the venv interpreter file the module checks for. */
function materializeVenvPython(envDir: string): string {
  const venvPython = getVenvPython(envDir);
  fs.mkdirSync(path.dirname(venvPython), { recursive: true });
  fs.writeFileSync(venvPython, '');
  return venvPython;
}

describe('getVenvPython', () => {
  it('returns the platform-appropriate interpreter path', () => {
    const result = getVenvPython('/data/pyenv');
    if (process.platform === 'win32') {
      expect(result).toBe(path.join('/data/pyenv', 'Scripts', 'python.exe'));
    } else {
      expect(result).toBe(path.join('/data/pyenv', 'bin', 'python'));
    }
  });
});

describe('getManagedEnvDir', () => {
  it('lives outside the vault in a per-machine data directory', () => {
    const dir = getManagedEnvDir();
    expect(dir).toContain(path.join('eink-sync', 'pyenv'));
    expect(path.isAbsolute(dir)).toBe(true);
  });
});

describe('ensureManagedPython', () => {
  let envDir: string;

  beforeEach(() => {
    resetManagedPythonStateForTests();
    envDir = makeTempEnvDir();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(envDir), { recursive: true, force: true });
  });

  it('uses an existing env that passes the import check without provisioning', async () => {
    const venvPython = materializeVenvPython(envDir);
    const { runner, calls } = makeRunner((cmd) => (cmd === venvPython ? ok : fail));

    const result = await ensureManagedPython({ envDir, runner });

    expect(result).toEqual({ pythonPath: venvPython, managed: true, created: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ cmd: venvPython, args: ['-c', 'import rmscene, fitz'] });
  });

  it('creates the env with uv when available', async () => {
    const venvPython = getVenvPython(envDir);
    const { runner, calls } = makeRunner((cmd, args) => {
      if (cmd === 'uv' && args[0] === 'venv') {
        materializeVenvPython(envDir);
        return ok;
      }
      if (cmd === 'uv') return ok; // --version, pip install
      if (cmd === venvPython) return ok; // import verification
      return fail;
    });

    const result = await ensureManagedPython({ envDir, runner });

    expect(result).toEqual({ pythonPath: venvPython, managed: true, created: true });
    const uvCalls = calls.filter((c) => c.cmd === 'uv').map((c) => c.args);
    expect(uvCalls).toContainEqual(['venv', envDir]);
    expect(uvCalls).toContainEqual(['pip', 'install', '--python', venvPython, ...REQUIRED_PACKAGES]);
  });

  it('falls back to python -m venv + pip when uv is missing', async () => {
    const venvPython = getVenvPython(envDir);
    const { runner, calls } = makeRunner((cmd, args) => {
      if (cmd === 'uv') return fail;
      if (cmd === 'python3' && args[0] === '--version') {
        return { code: 0, stdout: 'Python 3.12.1', stderr: '' };
      }
      if (cmd === 'python3' && args[0] === '-m' && args[1] === 'venv') {
        materializeVenvPython(envDir);
        return ok;
      }
      if (cmd === venvPython) return ok; // pip install + import verification
      return fail;
    });

    const result = await ensureManagedPython({ envDir, runner });

    expect(result).toEqual({ pythonPath: venvPython, managed: true, created: true });
    const pipInstall = calls.find(
      (c) => c.cmd === venvPython && c.args[1] === 'pip' && c.args[2] === 'install',
    );
    expect(pipInstall).toBeDefined();
    expect(pipInstall!.args).toEqual(
      expect.arrayContaining(REQUIRED_PACKAGES),
    );
  });

  it('repairs a broken env by reinstalling packages before rebuilding', async () => {
    const venvPython = materializeVenvPython(envDir);
    let importChecks = 0;
    const { runner } = makeRunner((cmd, args) => {
      if (cmd === venvPython && args[0] === '-c') {
        // The healthy-env check (tried twice) fails, later checks succeed
        // once the packages have been reinstalled.
        importChecks++;
        return importChecks <= 2 ? fail : ok;
      }
      if (cmd === 'uv') return ok; // --version + pip install repair
      return fail;
    });

    const result = await ensureManagedPython({ envDir, runner });

    expect(result).toEqual({ pythonPath: venvPython, managed: true, created: true });
  });

  it('falls back to a system Python that has the deps when provisioning fails', async () => {
    const { runner } = makeRunner((cmd, args) => {
      if (cmd === 'python3' && args[0] === '--version') {
        return { code: 0, stdout: 'Python 3.11.0', stderr: '' };
      }
      if (cmd === 'python3' && args[0] === '-c') return ok; // deps present
      return fail; // uv missing, venv creation fails
    });

    const result = await ensureManagedPython({ envDir, runner });

    expect(result).toEqual({ pythonPath: 'python3', managed: false, created: false });
  });

  it('throws PYTHON_DEPS_MISSING when nothing is usable', async () => {
    const { runner } = makeRunner(() => fail);

    await expect(ensureManagedPython({ envDir, runner })).rejects.toMatchObject({
      code: ErrorCode.PYTHON_DEPS_MISSING,
    });
    await expect(ensureManagedPython({ envDir, runner })).rejects.toBeInstanceOf(BridgeError);
  });

  it('recreates an env dir that exists without an interpreter (uv would refuse)', async () => {
    // Simulates a killed provisioning run or a dangling-interpreter venv:
    // the directory is there, the python executable is not.
    fs.mkdirSync(envDir, { recursive: true });
    const strayFile = path.join(envDir, 'stray.txt');
    fs.writeFileSync(strayFile, 'leftover');
    const venvPython = getVenvPython(envDir);
    const { runner } = makeRunner((cmd, args) => {
      if (cmd === 'uv' && args[0] === 'venv') {
        // uv fails on a pre-existing directory; the module must have
        // removed it before ever calling this.
        if (fs.existsSync(strayFile)) {
          return { code: 2, stdout: '', stderr: 'A directory already exists' };
        }
        materializeVenvPython(envDir);
        return ok;
      }
      if (cmd === 'uv') return ok;
      if (cmd === venvPython) return ok;
      return fail;
    });

    const result = await ensureManagedPython({ envDir, runner });

    expect(result).toEqual({ pythonPath: venvPython, managed: true, created: true });
    expect(fs.existsSync(strayFile)).toBe(false);
  });

  it('shares one provisioning attempt across concurrent calls', async () => {
    const venvPython = getVenvPython(envDir);
    const { runner, calls } = makeRunner((cmd, args) => {
      if (cmd === 'uv' && args[0] === 'venv') {
        materializeVenvPython(envDir);
        return ok;
      }
      if (cmd === 'uv') return ok;
      if (cmd === venvPython) return ok;
      return fail;
    });

    const [a, b] = await Promise.all([
      ensureManagedPython({ envDir, runner }),
      ensureManagedPython({ envDir, runner }),
    ]);

    expect(a).toEqual(b);
    expect(calls.filter((c) => c.cmd === 'uv' && c.args[0] === 'venv')).toHaveLength(1);
  });

  it('does not re-provision immediately after a failed attempt', async () => {
    const { runner, calls } = makeRunner(() => fail);

    await expect(ensureManagedPython({ envDir, runner })).rejects.toBeInstanceOf(BridgeError);
    const callsAfterFirst = calls.length;
    await expect(ensureManagedPython({ envDir, runner })).rejects.toBeInstanceOf(BridgeError);

    // The second call skips provisioning (no uv/venv activity), only the
    // system-Python fallback probes run again.
    const secondCallCmds = calls.slice(callsAfterFirst).map((c) => c.cmd);
    expect(secondCallCmds).not.toContain('uv');
    expect(secondCallCmds).toEqual(['python3', 'python']);
  });

  it('installs OCR extras best-effort without failing the run', async () => {
    const venvPython = materializeVenvPython(envDir);
    const { runner, calls } = makeRunner((cmd, args) => {
      if (cmd === venvPython && args[1] === 'import rmscene, fitz') return ok;
      if (cmd === venvPython && args[1] === 'import pytesseract, PIL') return fail;
      if (cmd === 'uv' && args[0] === '--version') return ok;
      if (cmd === 'uv' && args[0] === 'pip') return fail; // OCR install fails
      return fail;
    });

    const result = await ensureManagedPython({ envDir, runner, ocrExtras: true });

    expect(result.managed).toBe(true);
    const ocrInstall = calls.find(
      (c) => c.cmd === 'uv' && c.args.includes('pytesseract>=0.3.10'),
    );
    expect(ocrInstall).toBeDefined();
  });
});
