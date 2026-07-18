/**
 * Bridge between TypeScript and the Python extraction module.
 *
 * Spawns a Python child process that runs the rmscene + PyMuPDF extraction
 * pipeline and parses the JSON output from stdout. All communication is
 * one-directional: TypeScript sends arguments via CLI flags, Python returns
 * results as a single JSON object on stdout.
 *
 * Why Python? rmscene (the only maintained v6 .rm parser) and PyMuPDF
 * (for PDF text correlation) are Python-only libraries. Rather than
 * rewriting them in TypeScript, we call them as a subprocess.
 *
 * The Python script location is resolved relative to the plugin directory.
 * Users must have Python 3.8+ with rmscene and PyMuPDF installed.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { logger } from '../utils/logger';
import { BridgeError, ErrorCode } from '../types/errors';
import {
  HighlightExtractor,
  ReMarkableDocument,
  ExtractionResult,
  ExtractedHighlight,
} from './types';

/** Timeout for the Python extraction process (5 minutes). */
const EXTRACTION_TIMEOUT_MS = 300_000;

/** Maximum stdout buffer size (50 MB) to prevent memory issues. */
const MAX_STDOUT_SIZE = 50 * 1024 * 1024;

/**
 * JSON output shape from the Python extraction script (extract.py).
 *
 * This interface mirrors the output format documented in extract.py.
 */
export interface PythonExtractionOutput {
  success: boolean;
  documents: PythonDocumentResult[];
  errors: string[];
}

/** Per-document result from the Python extraction script. */
export interface PythonDocumentResult {
  uuid: string;
  visible_name: string;
  folder_path: string;
  doc_type: string;
  last_modified: number;
  page_count: number;
  has_pdf: boolean;
  highlights: PythonHighlight[];
  warnings: string[];
  error: string | null;
  tags?: string[];
  page_tags?: Record<string, string[]>;
}

/** A single highlight as returned by the Python script. */
export interface PythonHighlight {
  text: string;
  page_number: number;
  color: string | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  created_at: number | null;
}

/** Options for invoking the Python extraction process. */
export interface ExtractionOptions {
  /** Absolute path to the synced xochitl directory. */
  xochitlPath: string;
  /** Extract only a specific document by UUID (optional). */
  docUuid?: string;
  /**
   * Restrict extraction to this set of document UUIDs (optional). Used to
   * honor a "extract selected document(s)" request so the script does not
   * process (and the pipeline does not overwrite) the entire library.
   */
  docUuids?: string[];
  /** Only process documents modified after this epoch-ms timestamp (optional). */
  sinceTimestamp?: number;
  /** Override Python executable path (default: "python3" or "python"). */
  pythonPath?: string;
  /** Override extraction script path (default: auto-resolved). */
  scriptPath?: string;
  /** Plugin directory (where extraction/ scripts live). */
  pluginDir?: string;
  /** Timeout in milliseconds (default: EXTRACTION_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Whether to include EPUB documents in extraction. */
  includeEpub?: boolean;
}

/**
 * Resolve the path to the Python extraction script.
 *
 * The script is located at extraction/extract.py relative to the project root.
 * The plugin directory is typically the root of the installed plugin.
 */
export function resolveScriptPath(pluginDir: string): string {
  return path.join(pluginDir, 'extraction', 'extract.py');
}

/**
 * Detect the available Python executable on the system.
 *
 * Tries "python3" first (standard on macOS/Linux), then "python" (Windows).
 * Returns the first executable that responds to --version.
 */
export async function detectPythonPath(): Promise<string> {
  const candidates = ['python3', 'python'];

  for (const candidate of candidates) {
    const available = await testPythonExecutable(candidate);
    if (available) {
      logger.debug(`Using Python executable: ${candidate}`);
      return candidate;
    }
  }

  throw new BridgeError(
    ErrorCode.PYTHON_NOT_FOUND,
    'Python 3 is not installed or not in PATH.',
    'Install Python 3.8+ from https://www.python.org/ and ensure it is in your PATH.',
  );
}

/**
 * Test whether a Python executable is available and meets version requirements.
 */
async function testPythonExecutable(executable: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const proc = spawn(executable, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });

      let output = '';
      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 && output.includes('Python 3')) {
          resolve(true);
        } else {
          resolve(false);
        }
      });

      proc.on('error', () => {
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Verify that the required Python packages (rmscene, PyMuPDF) are installed.
 *
 * @param pythonPath - Path to the Python executable.
 * @returns Object with installed status and missing packages list.
 */
export async function checkPythonDependencies(
  pythonPath: string,
): Promise<{ installed: boolean; missing: string[] }> {
  const packages = ['rmscene', 'fitz'];
  const missing: string[] = [];

  for (const pkg of packages) {
    const available = await checkPythonPackage(pythonPath, pkg);
    if (!available) {
      // Map internal module names to pip package names
      const pipName = pkg === 'fitz' ? 'PyMuPDF' : pkg;
      missing.push(pipName);
    }
  }

  return { installed: missing.length === 0, missing };
}

/**
 * Check if a specific Python package is importable.
 */
async function checkPythonPackage(
  pythonPath: string,
  packageName: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const proc = spawn(
        pythonPath,
        ['-c', `import ${packageName}`],
        { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
      );

      proc.on('close', (code) => resolve(code === 0));
      proc.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Run the Python extraction pipeline and return parsed results.
 *
 * This is the main bridge function. It:
 * 1. Resolves the Python executable and script paths
 * 2. Spawns a child process with the appropriate CLI arguments
 * 3. Captures stdout (JSON) and stderr (logs)
 * 4. Parses the JSON output into typed TypeScript objects
 * 5. Maps any errors to BridgeError with actionable suggestions
 *
 * @param options - Extraction parameters.
 * @returns The parsed extraction output from Python.
 * @throws BridgeError if Python is not available, dependencies are missing,
 *         the script fails, or the output is unparseable.
 */
export async function runPythonExtraction(
  options: ExtractionOptions,
): Promise<PythonExtractionOutput> {
  const pythonPath = options.pythonPath ?? await detectPythonPath();
  const scriptPath = options.scriptPath ?? resolveScriptPath(options.pluginDir ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? EXTRACTION_TIMEOUT_MS;

  // Build CLI arguments
  const args: string[] = [scriptPath, '--xochitl-path', options.xochitlPath];
  if (options.docUuid) {
    args.push('--doc-uuid', options.docUuid);
  }
  if (options.docUuids && options.docUuids.length > 0) {
    // Repeat --doc-uuid per UUID; extract.py collects them with action='append'.
    for (const uuid of options.docUuids) {
      args.push('--doc-uuid', uuid);
    }
  }
  if (options.sinceTimestamp !== undefined) {
    args.push('--since', options.sinceTimestamp.toString());
  }
  if (options.includeEpub) {
    args.push('--include-epub');
  }

  logger.info(`Running extraction: ${pythonPath} ${args.join(' ')}`);

  return new Promise<PythonExtractionOutput>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutSize = 0;
    let killed = false;

    const proc = spawn(pythonPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      // Set the working directory to the extraction module directory
      // so Python can find its sibling modules (metadata_parser, etc.)
      cwd: path.dirname(scriptPath),
    });

    proc.stdout.on('data', (data: Buffer) => {
      stdoutSize += data.length;
      if (stdoutSize > MAX_STDOUT_SIZE) {
        if (!killed) {
          killed = true;
          proc.kill('SIGTERM');
          reject(new BridgeError(
            ErrorCode.EXTRACTION_TIMEOUT,
            `Extraction output exceeded ${MAX_STDOUT_SIZE / 1024 / 1024}MB limit.`,
            'This may indicate a very large library. Try extracting a single document with --doc-uuid.',
          ));
        }
        return;
      }
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.debug(`[python] ${line}`);
        stderr += line + '\n';
      }
    });

    proc.on('close', (code) => {
      if (killed) return; // Already handled

      if (code !== 0) {
        // Map stderr content to specific error codes when possible
        const errorCode = stderr.includes('No module named')
          ? ErrorCode.PYTHON_DEPS_MISSING
          : ErrorCode.EXTRACTION_FAILED;
        reject(new BridgeError(
          errorCode,
          `Python extraction process exited with code ${code}.`,
          stderr
            ? `Python error output:\n${stderr.slice(0, 500)}`
            : 'Check that Python 3, rmscene, and PyMuPDF are installed correctly.',
        ));
        return;
      }

      // Parse JSON output
      try {
        const output: PythonExtractionOutput = JSON.parse(stdout);
        if (
          !output ||
          typeof output.success !== 'boolean' ||
          !Array.isArray(output.documents)
        ) {
          throw new Error('Invalid output structure');
        }
        // `errors` is optional in older outputs; normalize so callers can rely on it.
        if (!Array.isArray(output.errors)) {
          output.errors = [];
        }
        resolve(output);
      } catch (parseError) {
        reject(new BridgeError(
          ErrorCode.EXTRACTION_FAILED,
          'Failed to parse extraction output as JSON.',
          `Raw output (first 200 chars): ${stdout.slice(0, 200)}`,
          parseError instanceof Error ? parseError : undefined,
        ));
      }
    });

    proc.on('error', (err) => {
      if (killed) return;
      reject(new BridgeError(
        ErrorCode.PYTHON_NOT_FOUND,
        `Failed to spawn Python process: ${err.message}`,
        'Ensure Python 3 is installed and in your PATH.',
        err,
      ));
    });
  });
}

/**
 * Convert a Python document result to the TypeScript ExtractionResult type.
 *
 * This bridges the Python JSON output format to the TypeScript interfaces
 * defined in pipeline/types.ts.
 */
function pythonResultToExtractionResult(
  pyDoc: PythonDocumentResult,
): ExtractionResult {
  const document: ReMarkableDocument = {
    uuid: pyDoc.uuid,
    visibleName: pyDoc.visible_name,
    parentUuid: '',
    type: (pyDoc.doc_type as 'pdf' | 'epub' | 'notebook') || 'pdf',
    lastModified: pyDoc.last_modified,
    pageCount: pyDoc.page_count,
    pageUuids: [],
    hasPdf: pyDoc.has_pdf,
  };

  const highlights: ExtractedHighlight[] = pyDoc.highlights.map((h) => ({
    text: h.text,
    pageNumber: h.page_number,
    color: h.color,
    bounds: h.bounds,
    createdAt: h.created_at,
  }));

  return {
    document,
    highlights,
    warnings: pyDoc.warnings,
    formatDetected: 'v6',
    success: pyDoc.error === null,
    error: pyDoc.error,
    extractedAt: new Date().toISOString(),
    tags: pyDoc.tags ?? [],
    pageTags: pyDoc.page_tags ?? {},
  };
}

/**
 * HighlightExtractor implementation that delegates to the Python bridge.
 *
 * This class wraps runPythonExtraction() behind the HighlightExtractor
 * interface so that the pipeline orchestrator depends on the abstraction
 * rather than the concrete subprocess implementation.
 */
/**
 * Above this many documents we skip the per-UUID CLI filter and let the script
 * do a full scan (the pipeline re-filters the results either way). This keeps
 * the argv from blowing past OS command-line length limits on large libraries
 * while still scoping targeted "extract selected" requests, which are small.
 */
const MAX_DOC_UUID_ARGS = 100;

export class PythonHighlightExtractor implements HighlightExtractor {
  constructor(
    private pluginDir?: string,
    private includeEpub?: boolean,
    private pythonPath?: string,
  ) {}

  async extractHighlights(
    documents: ReMarkableDocument[],
    xochitlPath: string,
    sinceTimestamp?: number,
  ): Promise<ExtractionResult[]> {
    // Honor the requested document set so a "extract selected" request does not
    // process (and overwrite notes for) the entire library. For very large
    // sets we omit the filter to stay under argv limits; the pipeline applies a
    // definitive re-filter on the results regardless.
    const docUuids =
      documents.length > 0 && documents.length <= MAX_DOC_UUID_ARGS
        ? documents.map((d) => d.uuid)
        : undefined;

    const opts: ExtractionOptions = {
      xochitlPath,
      sinceTimestamp,
      pluginDir: this.pluginDir,
      includeEpub: this.includeEpub,
      docUuids,
      pythonPath: this.pythonPath,
    };

    const output = await runPythonExtraction(opts);

    // A pipeline-level failure (success:false) must surface as an error, not be
    // silently mapped to an empty document list that reads as "no new highlights".
    if (!output.success) {
      throw new BridgeError(
        ErrorCode.EXTRACTION_FAILED,
        'The extraction script reported a failure.',
        output.errors.length > 0
          ? output.errors.join('; ')
          : 'See the developer console / log for details.',
      );
    }

    return output.documents.map(pythonResultToExtractionResult);
  }
}
