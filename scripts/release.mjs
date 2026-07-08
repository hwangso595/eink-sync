#!/usr/bin/env node
/**
 * Cut a new plugin release end-to-end.
 *
 * Steps:
 *   1. Validate working tree is clean and required tools are available
 *   2. Bump version in manifest.json + package.json + versions.json
 *   3. Build (esbuild)
 *   4. Commit, tag (no `v` prefix), push
 *   5. Create the GitHub Release with the required Obsidian assets attached
 *      (manifest.json, main.js, styles.css) via the `gh` CLI
 *
 * Why all-in-one: a release that forgets to attach `main.js` looks broken to
 * users (Obsidian shows the plugin but install fails). Automating the asset
 * upload removes that footgun.
 *
 * Usage:
 *   node scripts/release.mjs 0.2.0
 *   node scripts/release.mjs 0.2.0 --min-app 1.5.0   (override minAppVersion entry)
 *   node scripts/release.mjs 0.2.0 --dry-run         (preview steps, write nothing)
 *
 * Requires the GitHub CLI (`gh`) authenticated for the target repo.
 */

import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EXTRACTION_DIR, RUNTIME_PY_FILES } from './runtime-assets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const newVersion = args[0];
if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('Usage: node scripts/release.mjs <version> [--min-app X.Y.Z] [--dry-run]');
  console.error('Example: node scripts/release.mjs 0.2.0');
  process.exit(1);
}
const minAppIdx = args.indexOf('--min-app');
const minAppOverride = minAppIdx >= 0 ? args[minAppIdx + 1] : null;
const dryRun = args.includes('--dry-run');

function sh(cmd) {
  if (dryRun) {
    console.log(`[dry-run] ${cmd}`);
    return '';
  }
  return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
}

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd]);
  return r.status === 0;
}

// 1. Preflight: clean tree + required tools
const status = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
if (status) {
  console.error('Working tree has uncommitted changes. Commit or stash first.');
  process.exit(1);
}
if (!which('gh')) {
  console.error('The `gh` CLI is required for asset upload. Install: https://cli.github.com/');
  process.exit(1);
}

// Runtime Python scripts are embedded into main.js at build time and
// materialized on load (Obsidian only delivers manifest/main.js/styles). Fail
// early if any is missing so we never ship a build that can't extract.
const missingAssets = RUNTIME_PY_FILES.filter(
  (rel) => !fs.existsSync(path.join(EXTRACTION_DIR, rel)),
);
if (missingAssets.length > 0) {
  console.error('Missing runtime extraction script(s) required for the build:');
  for (const rel of missingAssets) console.error(`  - extraction/${rel}`);
  console.error('See scripts/runtime-assets.mjs.');
  process.exit(1);
}
console.log(`Runtime assets OK: ${RUNTIME_PY_FILES.length} extraction script(s) will be embedded.`);

// 2. Bump versions
const manifestPath = path.join(ROOT, 'manifest.json');
const pkgPath = path.join(ROOT, 'package.json');
const versionsPath = path.join(ROOT, 'versions.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));

const minApp = minAppOverride || manifest.minAppVersion;
manifest.version = newVersion;
pkg.version = newVersion;
versions[newVersion] = minApp;

if (dryRun) {
  console.log(`[dry-run] would bump to ${newVersion} (minAppVersion=${minApp})`);
} else {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + '\n');
  console.log(`Bumped to ${newVersion} (minAppVersion=${minApp})`);
}

// 3. Build
console.log('Running build...');
if (!dryRun) {
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

// 4. Commit + tag + push
sh(`git add manifest.json package.json versions.json`);
sh(`git commit -m "release: ${newVersion}"`);
sh(`git tag ${newVersion}`);
sh(`git push origin HEAD`);
sh(`git push origin ${newVersion}`);
console.log(`Committed, tagged, and pushed ${newVersion}.`);

// 5. Create the GitHub Release with assets attached
const assets = ['manifest.json', 'main.js', 'styles.css']
  .map((f) => path.join(ROOT, f))
  .filter((p) => {
    if (!fs.existsSync(p)) {
      console.warn(`Skipping missing asset: ${path.basename(p)}`);
      return false;
    }
    return true;
  });

const ghArgs = [
  'release', 'create', newVersion,
  '--title', newVersion,
  '--notes', `Release ${newVersion}.`,
  ...assets,
];

if (dryRun) {
  console.log(`[dry-run] gh ${ghArgs.join(' ')}`);
} else {
  const r = spawnSync('gh', ghArgs, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('gh release create failed. You can run it manually:');
    console.error(`  gh ${ghArgs.join(' ')}`);
    process.exit(1);
  }
  console.log(`GitHub release ${newVersion} created with assets attached.`);
  console.log('Obsidian will pick up the update from the release within a few hours.');
}
