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
 * Privacy: Pure local computation. Zero network calls.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PageDrawings } from './markdown-renderer';
import type { ExtractedHighlight } from './types';
import { logger } from '../utils/logger';

/** Result of renderPageImages: page drawings map plus any renderer-extracted highlights. */
export interface PageImageResult {
  pageDrawings: PageDrawings;
  rendererHighlights: ExtractedHighlight[];
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
): Promise<PageImageResult | null> {
  if (!drawingsPath) return null;

  const rmDir = path.join(xochitlPath, doc.uuid);
  if (!fs.existsSync(rmDir)) return null;

  // Check that at least one .rm file has strokes (> 100 bytes)
  const contentPath = path.join(xochitlPath, `${doc.uuid}.content`);
  if (!fs.existsSync(contentPath)) return null;

  let hasAnyStrokes = false;
  try {
    const content = JSON.parse(fs.readFileSync(contentPath, 'utf-8'));
    let pageUuids: string[] = [];
    if (content.cPages?.pages) {
      pageUuids = content.cPages.pages
        .filter((p: any) => !p.deleted)
        .map((p: any) => p.id || p);
    } else if (content.pages) {
      pageUuids = content.pages;
    }

    for (const uuid of pageUuids) {
      const rmPath = path.join(rmDir, `${uuid}.rm`);
      if (fs.existsSync(rmPath)) {
        const stat = fs.statSync(rmPath);
        if (stat.size >= 100) {
          hasAnyStrokes = true;
          break;
        }
      }
    }
  } catch {
    return null;
  }

  if (!hasAnyStrokes) return null;

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

  // Detect Python executable
  const { spawn } = require('child_process');
  let pythonExe = 'python';
  try {
    const { detectPythonPath } = require('./python-bridge');
    pythonExe = await detectPythonPath();
  } catch {
    // Fall back to 'python'
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
      const proc = spawn(pythonExe, scriptArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 120000,
        cwd: scriptDir,
      });

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code: number) => {
        if (stderr) {
          logger.debug(`render_pages stderr: ${stderr.trim()}`);
        }

        if (code === 0) {
          try {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(stdout);
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
              parsed = JSON.parse(jsonLine);
            }

            if (parsed.success) {
              const pages = parsed.pages as Array<{
                page_number: number;
                filename: string;
                has_strokes: boolean;
                highlight_texts?: string[];
              }>;
              const map: PageDrawings = new Map();
              const rendererHighlights: ExtractedHighlight[] = [];
              for (const page of pages) {
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
              }
              resolve({ pageDrawings: map, rendererHighlights });
            } else {
              const errors = parsed.errors as string[] | undefined;
              reject(new Error(errors?.join('; ') || 'render_pages failed'));
            }
          } catch (e) {
            reject(new Error(`Failed to parse render_pages output: ${e}`));
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
    logger.warn(`Page image rendering failed for ${doc.visibleName}: ${err}`);
    throw err instanceof Error ? err : new Error(String(err));
  }
}
