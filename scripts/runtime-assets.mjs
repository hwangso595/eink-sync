/**
 * Single source of truth for the Python files the plugin needs at RUNTIME.
 *
 * These are the transitive import closure of the two scripts the TypeScript
 * bridge spawns:
 *   - extraction/extract.py        (highlight extraction; python-bridge.ts)
 *   - extraction/render_pages.py   (page/drawing PNGs; page-image-renderer.ts)
 *
 * Test files (test_*.py) and dev experiments (sweep_*.py, annotate_pdf.py, …)
 * are deliberately excluded so they never ship in a plugin install.
 *
 * Used by:
 *   - esbuild.config.mjs   — embeds these into main.js so Obsidian's
 *                            community auto-updater (which only fetches
 *                            manifest.json/main.js/styles.css) still delivers
 *                            them; the plugin materializes them to disk on load.
 *   - scripts/install-plugin.mjs — curated dev install (no test files).
 *   - scripts/release.mjs        — preflight assertion that all are present.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the extraction/ directory. */
export const EXTRACTION_DIR = path.resolve(__dirname, '..', 'extraction');

/**
 * Runtime Python files, relative to EXTRACTION_DIR. Order is documentation
 * only (import order does not matter for a curated copy).
 */
export const RUNTIME_PY_FILES = [
  // extract.py closure
  'extract.py',
  'metadata_parser.py',
  'highlight_extractor.py',
  'epub_support.py',
  'highlight_merger.py',
  'stroke_renderer.py',
  'legacy_rm_parser.py',
  'constants.py',
  // render_pages.py closure (adds these on top of the shared modules above)
  'render_pages.py',
  'png_renderer.py',
  'template_renderer.py',
  // Optional local OCR for handwriting search (imported lazily by render_pages).
  'ocr_engine.py',
];
