/**
 * Tests for settings.ts -- empty settings fallback and drawings folder derivation.
 *
 * Regression tests to prevent issues from coming back:
 * - Empty string settings should restore defaults
 * - Drawings folder is derived from highlights folder
 */

import {
  DEFAULT_SETTINGS,
  getDrawingsFolder,
  ReMarkableBridgeSettings,
} from './settings';

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Simulate the loadSettings logic from plugin.ts.
 *
 * This replicates the empty-string fallback behavior without needing
 * the full Obsidian Plugin class.
 */
function simulateLoadSettings(
  savedData: Partial<ReMarkableBridgeSettings> | null,
): ReMarkableBridgeSettings {
  const settings = Object.assign({}, DEFAULT_SETTINGS, savedData);
  if (savedData?.extraction) {
    settings.extraction = Object.assign(
      {},
      DEFAULT_SETTINGS.extraction,
      savedData.extraction,
    );
  }
  // Restore defaults for empty string settings that shouldn't be empty
  if (!settings.templatePath) {
    settings.templatePath = DEFAULT_SETTINGS.templatePath;
  }
  if (!settings.syncFolder) {
    settings.syncFolder = DEFAULT_SETTINGS.syncFolder;
  }
  if (!settings.highlightsFolder) {
    settings.highlightsFolder = DEFAULT_SETTINGS.highlightsFolder;
  }
  if (!settings.archiveFolder) {
    settings.archiveFolder = DEFAULT_SETTINGS.archiveFolder;
  }
  return settings;
}

// -------------------------------------------------------------------
// Empty settings fallback
// -------------------------------------------------------------------

describe('Empty settings fallback', () => {
  it('should restore default templatePath when saved data has empty string', () => {
    // Regression: Empty string for templatePath caused template loading to fail
    const settings = simulateLoadSettings({ templatePath: '' });
    expect(settings.templatePath).toBe(DEFAULT_SETTINGS.templatePath);
    expect(settings.templatePath).toBe('reMarkable/template.md');
  });

  it('should restore default syncFolder when saved data has empty string', () => {
    // Regression: Empty syncFolder caused xochitl discovery to scan vault root
    const settings = simulateLoadSettings({ syncFolder: '' });
    expect(settings.syncFolder).toBe(DEFAULT_SETTINGS.syncFolder);
    expect(settings.syncFolder).toBe('reMarkable/Sync');
  });

  it('should restore default highlightsFolder when saved data has empty string', () => {
    // Regression: Empty highlightsFolder caused outputs to be written to vault root
    const settings = simulateLoadSettings({ highlightsFolder: '' });
    expect(settings.highlightsFolder).toBe(DEFAULT_SETTINGS.highlightsFolder);
    expect(settings.highlightsFolder).toBe('reMarkable/Highlights');
  });

  it('should restore default archiveFolder when saved data has empty string', () => {
    // Regression: Empty archiveFolder caused archive operations to fail
    const settings = simulateLoadSettings({ archiveFolder: '' });
    expect(settings.archiveFolder).toBe(DEFAULT_SETTINGS.archiveFolder);
    expect(settings.archiveFolder).toBe('reMarkable/Archive');
  });

  it('should keep non-empty custom paths', () => {
    const settings = simulateLoadSettings({
      templatePath: 'custom/template.md',
      syncFolder: 'custom/sync',
      highlightsFolder: 'custom/highlights',
      archiveFolder: 'custom/archive',
    });
    expect(settings.templatePath).toBe('custom/template.md');
    expect(settings.syncFolder).toBe('custom/sync');
    expect(settings.highlightsFolder).toBe('custom/highlights');
    expect(settings.archiveFolder).toBe('custom/archive');
  });

  it('should handle null saved data gracefully', () => {
    const settings = simulateLoadSettings(null);
    expect(settings.templatePath).toBe(DEFAULT_SETTINGS.templatePath);
    expect(settings.syncFolder).toBe(DEFAULT_SETTINGS.syncFolder);
    expect(settings.highlightsFolder).toBe(DEFAULT_SETTINGS.highlightsFolder);
    expect(settings.archiveFolder).toBe(DEFAULT_SETTINGS.archiveFolder);
  });

  it('should merge nested extraction preferences with defaults', () => {
    // Regression: Partial extraction prefs should not lose other defaults
    const settings = simulateLoadSettings({
      extraction: {
        incrementalOnly: false,
        includeColors: true,
        groupByPage: true,
        pdfLinkFormat: 'pdfpp',
        defaultTags: [],
        overwriteExisting: false,
      },
    });
    expect(settings.extraction.incrementalOnly).toBe(false);
    expect(settings.extraction.includeColors).toBe(true);
  });
});

// -------------------------------------------------------------------
// Drawings folder derivation
// -------------------------------------------------------------------

describe('getDrawingsFolder', () => {
  it('should return highlightsFolder + /drawings', () => {
    // Regression: Drawings folder was a separate setting that could
    // get out of sync with highlights folder. Now it's derived.
    const settings = { ...DEFAULT_SETTINGS };
    expect(getDrawingsFolder(settings)).toBe('reMarkable/Highlights/drawings');
  });

  it('should derive from custom highlights folder', () => {
    const settings = { ...DEFAULT_SETTINGS, highlightsFolder: 'my/notes' };
    expect(getDrawingsFolder(settings)).toBe('my/notes/drawings');
  });

  it('should handle highlights folder without trailing slash', () => {
    const settings = { ...DEFAULT_SETTINGS, highlightsFolder: 'folder' };
    expect(getDrawingsFolder(settings)).toBe('folder/drawings');
  });
});
