/**
 * Page image renderer for documents with pen strokes.
 *
 * Extracted from extraction-pipeline.ts to isolate the Python process
 * management, JSON parsing (with MuPDF stdout-pollution fallback),
 * filesystem checks, and image-map construction into a single-
 * responsibility module.
 *
 * Calls the Python render_pages.py script which uses PyMuPDF to render
 * .rm stroke data as PNG images at the reMarkable's native resolution
 * (1404x1872). Returns a Map from page number to PNG filename, or null
 * if no strokes are found.
 *
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import type { PageDrawings } from './markdown-renderer';
import type { ExtractedHighlight, PageOcr } from './types';
import { detectPythonPath } from './python-bridge';
import { logger } from '../utils/logger';

interface RenderedPage {
  page_number: number;
  filename: string;
  has_strokes: boolean;
  highlight_texts?: string[];
  ocr_text?: string;
}

interface RenderOutput {
  success: boolean;
  pages: RenderedPage[];
  errors?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function pageUuidsFromContent(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const cPages = value.cPages;
  if (isRecord(cPages) && Array.isArray(cPages.pages)) {
    return cPages.pages.flatMap((page): string[] => {
      if (typeof page === 'string') return [page];
      if (!isRecord(page) || page.deleted === true) return [];
      const id = typeof page.id === 'string'
        ? page.id
        : typeof page.uuid === 'string' ? page.uuid : '';
      return id ? [id] : [];
    });
  }
  return Array.isArray(value.pages)
    ? value.pages.filter((page): page is string => typeof page === 'string')
    : [];
}

function isRenderedPage(value: unknown): value is RenderedPage {
  if (!isRecord(value)) return false;
  return typeof value.page_number === 'number'
    && typeof value.filename === 'string'
    && typeof value.has_strokes === 'boolean'
    && (value.highlight_texts === undefined || (
      Array.isArray(value.highlight_texts)
      && value.highlight_texts.every((text) => typeof text === 'string')
    ))
    && (value.ocr_text === undefined || typeof value.ocr_text === 'string');
}

function parseRenderOutput(json: string): RenderOutput {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || typeof value.success !== 'boolean') {
    throw new Error('Invalid render_pages output structure');
  }
  const pages = value.pages;
  const errors = value.errors;
  if (!Array.isArray(pages) || !pages.every(isRenderedPage)) {
    throw new Error('Invalid render_pages page data');
  }
  if (errors !== undefined && (
    !Array.isArray(errors) || !errors.every((error) => typeof error === 'string')
  )) {
    throw new Error('Invalid render_pages error data');
  }
  return { success: value.success, pages, errors };
}

/** Result of renderPageImages: page drawings, renderer highlights, and OCR text. */
export interface PageImageResult {
  pageDrawings: PageDrawings;
  rendererHighlights: ExtractedHighlight[];
  /** Map of page number to OCR'd handwriting text (empty unless OCR is enabled). */
  pageOcr: PageOcr;
}

/** Rendering options forwarded to render_pages.py as CLI flags. */
export interface RenderPageOptions {
  /** Crop trailing blank space on short notebook pages. */
  truncateBlankSpace?: boolean;
  /** Run local OCR on notebook pages for handwriting search. */
  ocrEnabled?: boolean;
  /** Tesseract language code(s) for OCR. */
  ocrLanguage?: string;
  /** Per-page OCR time budget in seconds (0 = unlimited). Defaults to 12. */
  ocrPageTimeoutSeconds?: number;
  /** Directory of reMarkable page-template PNGs to draw behind notebook strokes. */
  templatesDir?: string;
  /** Python executable to use (resolved managed env). Falls back to PATH detection. */
  pythonPath?: string;
}

/** Base timeout for the page renderer process when OCR is off. */
const RENDER_TIMEOUT_MS = 120_000;
/** Extra process time granted per stroked page when OCR is on. */
const OCR_TIMEOUT_PER_PAGE_MS = 15_000;
/** Hard ceiling on the OCR-scaled render timeout (20 minutes). */
const OCR_TIMEOUT_MAX_MS = 1_200_000;
/** Default per-page OCR budget, mirrored in render_pages.py's --ocr-page-timeout. */
const DEFAULT_OCR_PAGE_TIMEOUT_S = 12;

/**
 * Total timeout (ms) for the render_pages.py process.
 *
 * OCR runs per page inside this single process budget, so with OCR enabled a
 * large notebook could blow the fixed 120s and fail the entire (otherwise
 * successful) page render. When OCR is on the budget scales with the number of
 * stroked pages, capped at {@link OCR_TIMEOUT_MAX_MS}. Per-page OCR is itself
 * time-bounded in Python, so this only guards the aggregate. Without OCR the
 * timeout is unchanged.
 */
export function computeRenderTimeoutMs(strokedPageCount: number, ocrEnabled: boolean): number {
  if (!ocrEnabled) return RENDER_TIMEOUT_MS;
  const pages = Math.max(0, strokedPageCount);
  return Math.min(RENDER_TIMEOUT_MS + OCR_TIMEOUT_PER_PAGE_MS * pages, OCR_TIMEOUT_MAX_MS);
}

/**
 * Render page images (PNGs) for a document that has pen strokes.
 *
 * Returns page drawings map and any highlight texts extracted by the renderer,
 * or null if no strokes are found.
 */
export async function renderPageImages(
  doc: { uuid: string; visibleName: string },
  xochitlPath: string,
  drawingsPath: string | undefined,
  pluginDir?: string,
  outputBaseName?: string,
  options: RenderPageOptions = {},
): Promise<PageImageResult | null> {
  if (!drawingsPath) return null;

  const rmDir = path.join(xochitlPath, doc.uuid);
  if (!fs.existsSync(rmDir)) return null;

  // Check that at least one .rm file has strokes (> 100 bytes)
  const contentPath = path.join(xochitlPath, `${doc.uuid}.content`);
  if (!fs.existsSync(contentPath)) return null;

  // Count pages that actually carry strokes. The count also scales the OCR
  // process timeout below, so we tally all of them rather than stopping at the
  // first (the extra stat() calls are negligible next to the render itself).
  let strokedPageCount = 0;
  try {
    const content: unknown = JSON.parse(fs.readFileSync(contentPath, 'utf-8'));
    const pageUuids = pageUuidsFromContent(content);

    for (const uuid of pageUuids) {
      const rmPath = path.join(rmDir, `${uuid}.rm`);
      if (fs.existsSync(rmPath)) {
        const stat = fs.statSync(rmPath);
        if (stat.size >= 100) {
          strokedPageCount++;
        }
      }
    }
  } catch {
    return null;
  }

  if (strokedPageCount === 0) return null;

  const scriptDir = pluginDir
    ? path.join(pluginDir, 'extraction')
    : path.join(process.cwd(), 'extraction');
  const scriptPath = path.join(scriptDir, 'render_pages.py');

  if (!fs.existsSync(scriptPath)) {
    // The document HAS strokes to render but the renderer script is missing --
    // this is a packaging/install fault, not a "nothing to render". Throw so the
    // caller can tell "renderer failed" from "genuinely no drawings" and must
    // NOT clear an existing note's drawings.
    throw new Error(
      `render_pages.py not found at ${scriptPath}. The extraction scripts were not ` +
      `installed -- reload the plugin so it can rewrite them.`,
    );
  }

  if (!fs.existsSync(drawingsPath)) {
    fs.mkdirSync(drawingsPath, { recursive: true });
  }

  let pythonExe = options.pythonPath ?? 'python';
  if (!options.pythonPath) {
    try {
      pythonExe = await detectPythonPath();
    } catch {
      // Fall back to 'python'
    }
  }

  logger.info(`Rendering page images: ${doc.visibleName}, python=${pythonExe}`);

  try {
    const pageMap = await new Promise<PageImageResult>((resolve, reject) => {
      const scriptArgs = [
        scriptPath,
        '--xochitl-path', xochitlPath,
        '--doc-uuid', doc.uuid,
        '--output-dir', drawingsPath,
      ];
      // Pass the collision-resolved base name so page-image filenames match the
      // note filename (two same-named docs won't overwrite each other's PNGs).
      if (outputBaseName) {
        scriptArgs.push('--doc-name', outputBaseName);
      }
      if (options.truncateBlankSpace) {
        scriptArgs.push('--truncate-blank');
      }
      if (options.ocrEnabled) {
        scriptArgs.push(
          '--ocr', '--ocr-lang', options.ocrLanguage || 'eng',
          '--ocr-page-timeout', String(options.ocrPageTimeoutSeconds ?? DEFAULT_OCR_PAGE_TIMEOUT_S),
        );
      }
      if (options.templatesDir && fs.existsSync(options.templatesDir)) {
        scriptArgs.push('--templates-dir', options.templatesDir);
      }
      const proc = spawn(pythonExe, scriptArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: computeRenderTimeoutMs(strokedPageCount, !!options.ocrEnabled),
        cwd: scriptDir,
      });

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code: number | null) => {
        if (stderr) {
          logger.debug(`render_pages stderr: ${stderr.trim()}`);
        }

        if (code === 0) {
          try {
            let parsed: RenderOutput;
            try {
              parsed = parseRenderOutput(stdout);
            } catch {
              // Fallback: find the last line that looks like JSON
              // (handles MuPDF stdout pollution)
              const lines = stdout.trim().split('\n');
              const jsonLine = lines.reverse().find(
                (l) => l.startsWith('{') && l.endsWith('}'),
              );
              if (!jsonLine) {
                throw new Error(
                  `No JSON found in render_pages stdout (${stdout.length} bytes, ` +
                  `first 200 chars: ${stdout.slice(0, 200)})`,
                );
              }
              parsed = parseRenderOutput(jsonLine);
            }

            if (parsed.success) {
              const map: PageDrawings = new Map();
              const rendererHighlights: ExtractedHighlight[] = [];
              const pageOcr: PageOcr = new Map();
              for (const page of parsed.pages) {
                if (page.has_strokes) {
                  map.set(page.page_number, page.filename);
                }
                for (const text of page.highlight_texts ?? []) {
                  rendererHighlights.push({
                    text,
                    pageNumber: page.page_number,
                    color: 'yellow',
                    bounds: null,
                    createdAt: null,
                  });
                }
                const ocrText = page.ocr_text?.trim();
                if (ocrText) {
                  pageOcr.set(page.page_number, ocrText);
                }
              }
              resolve({ pageDrawings: map, rendererHighlights, pageOcr });
            } else {
              reject(new Error(parsed.errors?.join('; ') || 'render_pages failed'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse render_pages output: ${String(e)}`));
          }
        } else {
          reject(new Error(stderr || `render_pages exit code ${code}`));
        }
      });

      proc.on('error', (err: Error) => {
        logger.error(`render_pages spawn error: ${err.message}`);
        reject(err);
      });
    });

    logger.info(`Page images rendered: ${pageMap.pageDrawings.size} page(s) with strokes, ${pageMap.rendererHighlights.length} renderer highlight(s)`);
    // A successful render that produced nothing is a legitimate empty result.
    return pageMap.pageDrawings.size > 0 || pageMap.rendererHighlights.length > 0 ? pageMap : null;
  } catch (err) {
    // A genuine render failure (spawn/timeout/exit/parse) on a document that we
    // already confirmed HAS strokes. Propagate it so the pipeline preserves any
    // existing note rather than clearing drawings it could not re-render.
    logger.warn(`Page image rendering failed for ${doc.visibleName}: ${String(err)}`);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
