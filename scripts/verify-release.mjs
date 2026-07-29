#!/usr/bin/env node
/**
 * Verify that the three files delivered by the community installer are enough
 * to load the plugin and contain every runtime extraction script.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Module, { builtinModules, createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PY_FILES } from './runtime-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredAssets = ['main.js', 'manifest.json', 'styles.css'];
for (const asset of requiredAssets) {
  const assetPath = path.join(root, asset);
  if (!fs.existsSync(assetPath) || fs.statSync(assetPath).size === 0) {
    throw new Error(`Missing or empty release asset: ${asset}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
if (manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error('manifest.json, package.json, and versions.json disagree');
}

const bundle = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
for (const runtimeFile of RUNTIME_PY_FILES) {
  if (!bundle.includes(JSON.stringify(runtimeFile) + ':')) {
    throw new Error(`Runtime extraction asset is not embedded: ${runtimeFile}`);
  }
}

const allowedExternal = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'obsidian',
  'electron',
  // ssh2 probes these optional accelerators inside try/catch and has JS fallbacks.
  'cpu-features',
  './crypto/build/Release/sshcrypto.node',
]);
const unresolved = new Set(
  [...bundle.matchAll(/require\(["']([^"']+)["']\)/g)]
    .map((match) => match[1])
    .filter((name) => !allowedExternal.has(name)),
);
if (unresolved.size > 0) {
  throw new Error(`Unexpected runtime require(s): ${[...unresolved].join(', ')}`);
}

class ObsidianStub {}
const obsidianStub = new Proxy({}, {
  get(_target, property) {
    if (property === 'Platform') return { isDesktopApp: true };
    return ObsidianStub;
  },
});
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'obsidian') return obsidianStub;
  return originalLoad.call(this, request, parent, isMain);
};
try {
  const require = createRequire(import.meta.url);
  const PluginClass = require(path.join(root, 'main.js'));
  if (typeof PluginClass !== 'function') {
    throw new Error('main.js did not export an Obsidian plugin class');
  }
} finally {
  Module._load = originalLoad;
}

console.log(
  `Release smoke test passed: ${requiredAssets.length} assets, ` +
  `${RUNTIME_PY_FILES.length} embedded Python scripts, bundle loads cleanly.`,
);
