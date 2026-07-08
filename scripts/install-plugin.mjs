#!/usr/bin/env node
/**
 * Install (or update) the plugin into an Obsidian vault.
 *
 * Copies the built plugin files to:
 *   <vault>/.obsidian/plugins/eink-sync/
 *
 * Usage:
 *   node scripts/install-plugin.mjs                    # prompts for vault path
 *   node scripts/install-plugin.mjs /path/to/vault     # uses argument
 *   OBSIDIAN_VAULT=/path/to/vault node scripts/install-plugin.mjs  # uses env var
 *
 * Re-run after each `npm run build` to update the plugin in your vault.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { RUNTIME_PY_FILES } from './runtime-assets.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PLUGIN_ID = 'eink-sync';

/** Files and directories to copy into the plugin folder. */
const ITEMS = [
  { src: 'main.js', dest: 'main.js' },
  { src: 'manifest.json', dest: 'manifest.json' },
  { src: 'styles.css', dest: 'styles.css' },
  { src: 'templates', dest: 'templates', isDir: true },
];

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  // Determine vault path from: CLI arg > env var > interactive prompt
  let vaultPath = process.argv[2] || process.env.OBSIDIAN_VAULT || '';

  if (!vaultPath) {
    vaultPath = await askQuestion('Enter the path to your Obsidian vault: ');
  }

  if (!vaultPath) {
    console.error('Error: No vault path provided.');
    process.exit(1);
  }

  vaultPath = path.resolve(vaultPath);

  // Validate vault path
  const obsidianDir = path.join(vaultPath, '.obsidian');
  if (!fs.existsSync(obsidianDir)) {
    console.error(`Error: "${vaultPath}" does not appear to be an Obsidian vault (.obsidian/ not found).`);
    process.exit(1);
  }

  // Ensure plugins directory exists
  const pluginsDir = path.join(obsidianDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const pluginDir = path.join(pluginsDir, PLUGIN_ID);
  fs.mkdirSync(pluginDir, { recursive: true });

  // Check that build output exists
  const mainJs = path.join(PROJECT_ROOT, 'main.js');
  if (!fs.existsSync(mainJs)) {
    console.error('Error: main.js not found. Run "npm run build" first.');
    process.exit(1);
  }

  // Copy each item
  let copied = 0;
  for (const item of ITEMS) {
    const srcPath = path.join(PROJECT_ROOT, item.src);
    const destPath = path.join(pluginDir, item.dest);

    if (!fs.existsSync(srcPath)) {
      console.warn(`  Skip: ${item.src} (not found)`);
      continue;
    }

    if (item.isDir) {
      copyDirSync(srcPath, destPath);
      console.log(`  Copied ${item.src}/ -> ${item.dest}/`);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`  Copied ${item.src} -> ${item.dest}`);
    }
    copied++;
  }

  // Copy only the curated runtime Python scripts (never test_*.py / experiments).
  // The plugin also materializes these from main.js on load; copying them here
  // makes a fresh dev install work immediately without a reload.
  const extractionDest = path.join(pluginDir, 'extraction');
  fs.mkdirSync(extractionDest, { recursive: true });
  let pyCopied = 0;
  for (const rel of RUNTIME_PY_FILES) {
    const srcPath = path.join(PROJECT_ROOT, 'extraction', rel);
    if (!fs.existsSync(srcPath)) {
      console.warn(`  Skip: extraction/${rel} (not found)`);
      continue;
    }
    fs.copyFileSync(srcPath, path.join(extractionDest, rel));
    pyCopied++;
  }
  console.log(`  Copied ${pyCopied} runtime Python script(s) -> extraction/`);

  console.log(`\nInstalled ${copied} item(s) + ${pyCopied} script(s) to: ${pluginDir}`);
  console.log('Restart Obsidian (or reload plugins) to pick up changes.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
