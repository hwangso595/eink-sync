#!/usr/bin/env node
/**
 * Cut a new plugin release end-to-end.
 *
 * Steps:
 *   1. Validate the working tree is clean
 *   2. Bump version in manifest.json, package.json, package-lock.json, and versions.json
 *   3. Build (esbuild)
 *   4. Commit, tag (no `v` prefix), push
 *   5. GitHub Actions rebuilds, attests, and publishes the release assets
 *
 * Release assets are intentionally published only by GitHub Actions so their
 * provenance can be verified with GitHub artifact attestations.
 *
 * Usage:
 *   node scripts/release.mjs 0.2.0
 *   node scripts/release.mjs 0.2.0 --min-app 1.5.0   (override minAppVersion entry)
 *   node scripts/release.mjs 0.2.0 --dry-run         (preview steps, write nothing)
 *
 */

import { execSync } from 'child_process';
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

// 1. Preflight: clean tree
const status = execSync('git status --porcelain', { cwd: ROOT }).toString().trim();
if (status) {
  console.error('Working tree has uncommitted changes. Commit or stash first.');
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
const packageLockPath = path.join(ROOT, 'package-lock.json');
const versionsPath = path.join(ROOT, 'versions.json');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));

const minApp = minAppOverride || manifest.minAppVersion;
manifest.version = newVersion;
pkg.version = newVersion;
packageLock.version = newVersion;
packageLock.packages[''].version = newVersion;
versions[newVersion] = minApp;

if (dryRun) {
  console.log(`[dry-run] would bump to ${newVersion} (minAppVersion=${minApp})`);
} else {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(packageLockPath, JSON.stringify(packageLock, null, 2) + '\n');
  fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + '\n');
  console.log(`Bumped to ${newVersion} (minAppVersion=${minApp})`);
}

// 3. Build
console.log('Running build...');
if (!dryRun) {
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

// 4. Commit + tag + push
sh(`git add manifest.json package.json package-lock.json versions.json`);
sh(`git commit -m "release: ${newVersion}"`);
sh(`git tag ${newVersion}`);
sh(`git push origin HEAD`);
sh(`git push origin ${newVersion}`);
console.log(`Committed, tagged, and pushed ${newVersion}.`);

// 5. The tag push triggers .github/workflows/release.yml. That workflow
// rebuilds from the tagged commit, verifies the source, attests each asset,
// and publishes the GitHub release.
console.log(`GitHub Actions will build, attest, and publish ${newVersion}.`);
