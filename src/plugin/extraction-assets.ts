/**
 * Materialize the embedded Python extraction scripts to disk.
 *
 * Obsidian's community-plugin auto-updater only downloads manifest.json,
 * main.js, and styles.css into the plugin folder -- it never places extra
 * files like our extraction/*.py. To make the plugin work on an auto-updated
 * install, the scripts are embedded into main.js at build time (see the
 * `extraction-assets` esbuild plugin) and written to
 * `<pluginDir>/extraction/` on load if they are missing or out of date.
 *
 * The bridge resolves scripts at `<pluginDir>/extraction/extract.py`
 * (python-bridge.ts resolveScriptPath), so this must run before any extraction.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXTRACTION_ASSETS, EXTRACTION_ASSETS_VERSION } from 'virtual:extraction-assets';
import { logger } from '../utils/logger';

/** Marker file recording which asset version is currently on disk. */
const VERSION_MARKER = '.assets-version';

/**
 * Write the embedded extraction scripts to `<pluginDir>/extraction/` when they
 * are absent or belong to a different build. Idempotent and cheap on the common
 * path (a version-marker read).
 *
 * @returns true if files were (re)written, false if already up to date.
 * @throws if the directory cannot be created or written.
 */
export function materializeExtractionAssets(pluginDir: string): boolean {
  const extractionDir = path.join(pluginDir, 'extraction');
  const markerPath = path.join(extractionDir, VERSION_MARKER);

  // Fast path: everything already present at the current version.
  try {
    if (
      fs.existsSync(markerPath) &&
      fs.readFileSync(markerPath, 'utf8').trim() === EXTRACTION_ASSETS_VERSION &&
      Object.keys(EXTRACTION_ASSETS).every((rel) => fs.existsSync(path.join(extractionDir, rel)))
    ) {
      return false;
    }
  } catch {
    // Fall through and rewrite.
  }

  fs.mkdirSync(extractionDir, { recursive: true });
  for (const [rel, contents] of Object.entries(EXTRACTION_ASSETS)) {
    const dest = path.join(extractionDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents, 'utf8');
  }
  fs.writeFileSync(markerPath, EXTRACTION_ASSETS_VERSION, 'utf8');

  logger.info(
    `Materialized ${Object.keys(EXTRACTION_ASSETS).length} extraction script(s) ` +
    `(version ${EXTRACTION_ASSETS_VERSION}) to ${extractionDir}`,
  );
  return true;
}
