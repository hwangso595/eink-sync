import esbuild from 'esbuild';

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

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/*',
    '@lezer/*',
  ],
  plugins: [nativeNodePlugin],
  format: 'cjs',
  target: 'es2020',
  outfile: 'dist/main.js',
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
