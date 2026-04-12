/**
 * Bridge between TypeScript and the Python OCR engine.
 *
 * Spawns a Python child process that runs Tesseract OCR via pytesseract
 * and returns results as JSON. OCR is entirely optional -- the pipeline
 * works without it.
 *
 * Privacy: All OCR processing is local (Tesseract). No cloud services.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { logger } from '../utils/logger';
import { BridgeError, ErrorCode } from '../types/errors';

/** Timeout for OCR operations (2 minutes). */
const OCR_TIMEOUT_MS = 120_000;

/** Maximum stdout buffer size (10 MB). */
const MAX_STDOUT_SIZE = 10 * 1024 * 1024;

/** OCR status as reported by the Python engine. */
export interface OcrStatus {
  available: boolean;
  pytesseract_installed: boolean;
  pillow_installed: boolean;
  tesseract_binary_found: boolean;
  tesseract_version: string | null;
  error: string | null;
}

/** Result of OCR on a single image. */
export interface OcrPageResult {
  text: string;
  confidence: number;
  language: string;
  warnings: string[];
  source: string;
}

/** Full output from the OCR Python script. */
export interface OcrOutput {
  success: boolean;
  mode: string;
  results: OcrPageResult[];
  status: OcrStatus | null;
  error: string | null;
}

/** Options for OCR operations. */
export interface OcrOptions {
  /** Override Python executable path. */
  pythonPath?: string;
  /** Override OCR script path. */
  scriptPath?: string;
  /** Tesseract language code (default: "eng"). */
  lang?: string;
  /** DPI for SVG rasterization (default: 150). */
  dpi?: number;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Resolve the path to the OCR Python script.
 */
export function resolveOcrScriptPath(pluginDir: string): string {
  return path.join(pluginDir, 'extraction', 'run_ocr.py');
}

/**
 * Check whether OCR is available on this system.
 *
 * Tests for pytesseract, Pillow, and the Tesseract binary.
 * Returns a status object with detailed diagnostics.
 */
export async function checkOcrStatus(options?: OcrOptions): Promise<OcrStatus> {
  try {
    const output = await runOcrProcess(['--mode', 'status'], options);
    if (output.status) {
      return output.status;
    }
    return {
      available: false,
      pytesseract_installed: false,
      pillow_installed: false,
      tesseract_binary_found: false,
      tesseract_version: null,
      error: output.error ?? 'Unknown error checking OCR status',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      pytesseract_installed: false,
      pillow_installed: false,
      tesseract_binary_found: false,
      tesseract_version: null,
      error: msg,
    };
  }
}

/**
 * Run OCR on a single image file and return the recognized text.
 *
 * @param imagePath - Absolute path to the image file (PNG, JPEG, etc.).
 * @param options - OCR configuration options.
 * @returns OCR result with text and confidence.
 */
export async function ocrImageFile(
  imagePath: string,
  options?: OcrOptions,
): Promise<OcrPageResult> {
  const args = ['--mode', 'file', '--input', imagePath];
  if (options?.lang) {
    args.push('--lang', options.lang);
  }

  const output = await runOcrProcess(args, options);
  if (!output.success || output.results.length === 0) {
    return {
      text: '',
      confidence: -1,
      language: options?.lang ?? 'eng',
      warnings: [output.error ?? 'OCR returned no results'],
      source: imagePath,
    };
  }
  return output.results[0];
}

/**
 * Run OCR on an SVG file by rasterizing and processing.
 *
 * @param svgPath - Absolute path to the SVG file.
 * @param options - OCR configuration options.
 * @returns OCR result with text and confidence.
 */
export async function ocrSvgFile(
  svgPath: string,
  options?: OcrOptions,
): Promise<OcrPageResult> {
  const args = ['--mode', 'svg', '--input', svgPath];
  if (options?.lang) {
    args.push('--lang', options.lang);
  }
  if (options?.dpi) {
    args.push('--dpi', String(options.dpi));
  }

  const output = await runOcrProcess(args, options);
  if (!output.success || output.results.length === 0) {
    return {
      text: '',
      confidence: -1,
      language: options?.lang ?? 'eng',
      warnings: [output.error ?? 'OCR returned no results'],
      source: svgPath,
    };
  }
  return output.results[0];
}

/**
 * Run OCR on multiple image files in a batch.
 *
 * @param imagePaths - Array of absolute paths to image files.
 * @param options - OCR configuration options.
 * @returns Array of OCR results (one per input, in order).
 */
export async function ocrBatch(
  imagePaths: string[],
  options?: OcrOptions,
): Promise<OcrPageResult[]> {
  if (imagePaths.length === 0) return [];

  const args = ['--mode', 'batch', '--input', ...imagePaths];
  if (options?.lang) {
    args.push('--lang', options.lang);
  }

  const output = await runOcrProcess(args, options);
  return output.results;
}

/**
 * Format OCR text as a collapsible section for embedding in markdown.
 *
 * @param ocrText - The OCR-recognized text.
 * @param confidence - OCR confidence score (0-100).
 * @returns Markdown string with a collapsible OCR section.
 */
export function formatOcrCollapsible(ocrText: string, confidence: number): string {
  if (!ocrText.trim()) return '';

  const confidenceLabel = confidence >= 0 ? ` (${confidence.toFixed(0)}% confidence)` : '';
  const lines: string[] = [];
  lines.push('');
  lines.push(`> [!note]- OCR Text${confidenceLabel}`);
  for (const line of ocrText.split('\n')) {
    lines.push(`> ${line}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Format OCR text as image alt-text.
 *
 * @param ocrText - The OCR-recognized text.
 * @returns Sanitized alt-text string (no newlines, truncated if long).
 */
export function formatOcrAltText(ocrText: string): string {
  // Replace newlines with spaces, collapse whitespace
  const cleaned = ocrText.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  // Truncate to reasonable alt-text length
  const MAX_ALT_LENGTH = 500;
  if (cleaned.length > MAX_ALT_LENGTH) {
    return cleaned.slice(0, MAX_ALT_LENGTH) + '...';
  }
  return cleaned;
}

/**
 * Spawn the Python OCR process and parse JSON output.
 */
async function runOcrProcess(
  cliArgs: string[],
  options?: OcrOptions,
): Promise<OcrOutput> {
  const pythonPath = options?.pythonPath ?? 'python3';
  const scriptPath = options?.scriptPath ?? resolveOcrScriptPath(process.cwd());
  const timeoutMs = options?.timeoutMs ?? OCR_TIMEOUT_MS;

  const args = [scriptPath, ...cliArgs];

  logger.debug(`Running OCR: ${pythonPath} ${args.join(' ')}`);

  return new Promise<OcrOutput>((resolve, reject) => {
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
            `OCR output exceeded ${MAX_STDOUT_SIZE / 1024 / 1024}MB limit.`,
            'The image may be too large or complex for OCR.',
          ));
        }
        return;
      }
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.debug(`[ocr] ${line}`);
        stderr += line + '\n';
      }
    });

    proc.on('close', (code) => {
      if (killed) return;

      if (code !== 0) {
        reject(new BridgeError(
          ErrorCode.EXTRACTION_FAILED,
          `OCR process exited with code ${code}.`,
          stderr
            ? `OCR error:\n${stderr.slice(0, 500)}`
            : 'Check that Python 3, pytesseract, Pillow, and Tesseract are installed.',
        ));
        return;
      }

      try {
        const output: OcrOutput = JSON.parse(stdout);
        resolve(output);
      } catch (parseError) {
        reject(new BridgeError(
          ErrorCode.EXTRACTION_FAILED,
          'Failed to parse OCR output as JSON.',
          `Raw output (first 200 chars): ${stdout.slice(0, 200)}`,
          parseError instanceof Error ? parseError : undefined,
        ));
      }
    });

    proc.on('error', (err) => {
      if (killed) return;
      reject(new BridgeError(
        ErrorCode.PYTHON_NOT_FOUND,
        `Failed to spawn OCR process: ${err.message}`,
        'Ensure Python 3 is installed and in your PATH.',
        err,
      ));
    });
  });
}
