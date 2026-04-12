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
import { logger } from '../utils/logger';

/**
 * Render page images (PNGs) for a document that has pen strokes.
 *
 * Returns a Map from page number to PNG filename, or null if no strokes.
 */
export async function renderPageImages(
  doc: { uuid: string; visibleName: string },
  xochitlPath: string,
  drawingsPath: string | undefined,
  pluginDir?: string,
): Promise<PageDrawings | null> {
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
    logger.debug('render_pages.py script not found, skipping stroke rendering');
    return null;
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
    const pageMap = await new Promise<PageDrawings>((resolve, reject) => {
      const proc = spawn(pythonExe, [
        scriptPath,
        '--xochitl-path', xochitlPath,
        '--doc-uuid', doc.uuid,
        '--output-dir', drawingsPath,
      ], {
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
              }>;
              const map: PageDrawings = new Map();
              for (const page of pages) {
                if (page.has_strokes) {
                  map.set(page.page_number, page.filename);
                }
              }
              resolve(map);
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

    logger.info(`Page images rendered: ${pageMap.size} page(s) with strokes`);
    return pageMap.size > 0 ? pageMap : null;
  } catch (err) {
    logger.warn(`Page image rendering failed for ${doc.visibleName}: ${err}`);
    return null;
  }
}
