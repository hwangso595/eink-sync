import esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EXTRACTION_DIR, RUNTIME_PY_FILES } from './scripts/runtime-assets.mjs';

const isWatch = process.argv.includes('--watch');

// Plugin to handle .node native bindings — ssh2 has optional native crypto
// that falls back to pure JS when unavailable.
const nativeNodePlugin = {
  name: 'native-node-bindings',
  setup(build) {
    build.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

// Embed the runtime Python scripts into main.js as string constants. Obsidian's
// community auto-updater only downloads manifest.json/main.js/styles.css, so the
// only reliable way to deliver the extraction scripts is inside the bundle; the
// plugin writes them to disk on load (see plugin/extraction-assets.ts).
const extractionAssetsPlugin = {
  name: 'extraction-assets',
  setup(build) {
    build.onResolve({ filter: /^virtual:extraction-assets$/ }, (args) => ({
      path: args.path,
      namespace: 'extraction-assets',
    }));
    build.onLoad({ filter: /.*/, namespace: 'extraction-assets' }, () => {
      const assets = {};
      for (const rel of RUNTIME_PY_FILES) {
        const abs = path.join(EXTRACTION_DIR, rel);
        if (!fs.existsSync(abs)) {
          throw new Error(`Runtime asset missing: extraction/${rel} (see scripts/runtime-assets.mjs)`);
        }
        assets[rel] = fs.readFileSync(abs, 'utf8');
      }
      const version = crypto
        .createHash('sha256')
        .update(JSON.stringify(assets))
        .digest('hex')
        .slice(0, 16);
      const contents =
        `export const EXTRACTION_ASSETS = ${JSON.stringify(assets)};\n` +
        `export const EXTRACTION_ASSETS_VERSION = ${JSON.stringify(version)};\n`;
      return { contents, loader: 'js' };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@lezer/*',
  ],
  plugins: [nativeNodePlugin, extractionAssetsPlugin],
  format: 'cjs',
  target: 'es2020',
  outfile: 'main.js',
  sourcemap: 'inline',
  platform: 'node',
  logLevel: 'info',
  // Obsidian requires module.exports to be the Plugin class directly,
  // not wrapped in { default: Plugin }. This footer unwraps it.
  footer: {
    js: 'module.exports = module.exports.default || module.exports;',
  },
});

if (isWatch) {
  await context.watch();
  console.log('Watching for changes...');
} else {
  await context.rebuild();
  await context.dispose();
}
