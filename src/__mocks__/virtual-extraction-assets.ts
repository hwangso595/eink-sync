/**
 * Jest stand-in for the build-time `virtual:extraction-assets` module.
 * The real module is produced by the esbuild `extraction-assets` plugin and
 * carries the actual Python sources; here we only need a small, stable fixture
 * for materialization tests.
 */
export const EXTRACTION_ASSETS: Record<string, string> = {
  'extract.py': '# fixture extract.py\n',
  'constants.py': '# fixture constants.py\n',
};

export const EXTRACTION_ASSETS_VERSION = 'testfixture0001';
