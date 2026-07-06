/**
 * Tests for materializeExtractionAssets -- the routine that writes the embedded
 * Python scripts to disk so an Obsidian auto-update (which only ships
 * manifest/main.js/styles) still yields a working extraction/ folder.
 *
 * The embedded asset map is stubbed by the Jest mock for
 * `virtual:extraction-assets` (see jest.config.js moduleNameMapper).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { materializeExtractionAssets } from './extraction-assets';
import { EXTRACTION_ASSETS, EXTRACTION_ASSETS_VERSION } from 'virtual:extraction-assets';

describe('materializeExtractionAssets', () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eink-assets-'));
  });

  afterEach(() => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it('writes every embedded script plus a version marker', () => {
    const wrote = materializeExtractionAssets(pluginDir);
    expect(wrote).toBe(true);
    for (const rel of Object.keys(EXTRACTION_ASSETS)) {
      const p = path.join(pluginDir, 'extraction', rel);
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, 'utf8')).toBe(EXTRACTION_ASSETS[rel]);
    }
    const marker = fs.readFileSync(path.join(pluginDir, 'extraction', '.assets-version'), 'utf8');
    expect(marker).toBe(EXTRACTION_ASSETS_VERSION);
  });

  it('is a no-op on the second call when nothing changed', () => {
    expect(materializeExtractionAssets(pluginDir)).toBe(true);
    expect(materializeExtractionAssets(pluginDir)).toBe(false);
  });

  it('rewrites when a script has been deleted from disk', () => {
    materializeExtractionAssets(pluginDir);
    const victim = path.join(pluginDir, 'extraction', 'extract.py');
    fs.rmSync(victim);
    expect(materializeExtractionAssets(pluginDir)).toBe(true);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it('rewrites when the on-disk version marker is stale', () => {
    materializeExtractionAssets(pluginDir);
    fs.writeFileSync(path.join(pluginDir, 'extraction', '.assets-version'), 'old-version', 'utf8');
    expect(materializeExtractionAssets(pluginDir)).toBe(true);
  });
});
