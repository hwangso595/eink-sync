/**
 * Bridge between TypeScript and the Python stroke rendering module.
 *
 * Spawns a Python child process that runs render_strokes.py to convert
 * .rm stroke data into SVG files. The Python script outputs JSON on stdout
 * describing which pages were rendered and where the SVG files are stored.
 *
 * This follows the same subprocess pattern as python-bridge.ts for highlight
 * extraction. See that module for the rationale on using Python subprocess.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { logger } from '../utils/logger';
import { BridgeError, ErrorCode } from '../types/errors';

/** Timeout for the stroke rendering process (3 minutes). */
const RENDER_TIMEOUT_MS = 180_000;

/** Maximum stdout buffer size (10 MB). */
const MAX_STDOUT_SIZE = 10 * 1024 * 1024;

/** Result for a single rendered page. */
export interface RenderedPage {
  pageIndex: number;
  pageUuid: string;
  svgPath: string | null;
  hasStrokes: boolean;
  strokeCount: number;
  error?: string;
}

/** Full output from the Python render_strokes.py script. */
export interface StrokeRenderOutput {
  success: boolean;
  pages: RenderedPage[];
  docType: string;
  visibleName: string;
  errors: string[];
}

/** JSON shape returned by the Python script (snake_case). */
interface PythonRenderOutput {
  success: boolean;
  pages: Array<{
    page_index: number;
    page_uuid: string;
    svg_path: string | null;
    has_strokes: boolean;
    stroke_count: number;
    error?: string;
  }>;
  doc_type: string;
  visible_name: string;
  errors: string[];
}

/** Options for rendering strokes from a document. */
export interface StrokeRenderOptions {
  /** Path to the synced xochitl directory. */
  xochitlPath: string;
  /** Document UUID. */
  docUuid: string;
  /** Directory to write SVG files into. */
  outputDir: string;
  /** Render with transparent background for PDF overlay. */
  pdfOverlay?: boolean;
  /** Override Python executable path. */
  pythonPath?: string;
  /** Override render script path. */
  scriptPath?: string;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Resolve the path to the Python render_strokes.py script.
 */
export function resolveRenderScriptPath(pluginDir: string): string {
  return path.join(pluginDir, 'extraction', 'render_strokes.py');
}

/**
 * Run the Python stroke renderer and return the results.
 *
 * Spawns render_strokes.py with the document mode arguments and parses
 * the JSON output into typed TypeScript objects.
 */
export async function renderDocumentStrokes(
  options: StrokeRenderOptions,
): Promise<StrokeRenderOutput> {
  const pythonPath = options.pythonPath ?? 'python3';
  const scriptPath = options.scriptPath ?? resolveRenderScriptPath(process.cwd());
  const timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;

  const args: string[] = [
    scriptPath,
    '--xochitl-path', options.xochitlPath,
    '--doc-uuid', options.docUuid,
    '--output-dir', options.outputDir,
  ];

  if (options.pdfOverlay) {
    args.push('--pdf-overlay');
  }

  logger.info(`Rendering strokes: ${pythonPath} ${args.join(' ')}`);

  return new Promise<StrokeRenderOutput>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutSize = 0;
    let killed = false;

    const proc = spawn(pythonPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
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
            `Stroke render output exceeded ${MAX_STDOUT_SIZE / 1024 / 1024}MB limit.`,
            'The document may have too many pages. Try rendering a smaller document.',
          ));
        }
        return;
      }
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.debug(`[python:render] ${line}`);
        stderr += line + '\n';
      }
    });

    proc.on('close', (code) => {
      if (killed) return;

      if (code !== 0) {
        const errorCode = stderr.includes('No module named')
          ? ErrorCode.PYTHON_DEPS_MISSING
          : ErrorCode.EXTRACTION_FAILED;
        reject(new BridgeError(
          errorCode,
          `Stroke render process exited with code ${code}.`,
          stderr
            ? `Python error output:\n${stderr.slice(0, 500)}`
            : 'Check that Python 3 and rmscene are installed correctly.',
        ));
        return;
      }

      try {
        const raw: PythonRenderOutput = JSON.parse(stdout);
        const output: StrokeRenderOutput = {
          success: raw.success,
          docType: raw.doc_type,
          visibleName: raw.visible_name,
          errors: raw.errors,
          pages: raw.pages.map((p) => ({
            pageIndex: p.page_index,
            pageUuid: p.page_uuid,
            svgPath: p.svg_path,
            hasStrokes: p.has_strokes,
            strokeCount: p.stroke_count,
            error: p.error,
          })),
        };
        resolve(output);
      } catch (parseError) {
        reject(new BridgeError(
          ErrorCode.EXTRACTION_FAILED,
          'Failed to parse stroke render output as JSON.',
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
