#!/usr/bin/env node
/**
 * Install (or update) the plugin into an Obsidian vault.
 *
 * Copies the built plugin files to:
 *   <vault>/.obsidian/plugins/remarkable-obsidian-bridge/
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const PLUGIN_ID = 'remarkable-obsidian-bridge';

/** Files and directories to copy into the plugin folder. */
const ITEMS = [
  { src: 'dist/main.js', dest: 'main.js' },
  { src: 'manifest.json', dest: 'manifest.json' },
  { src: 'styles.css', dest: 'styles.css' },
  { src: 'extraction', dest: 'extraction', isDir: true },
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
  const mainJs = path.join(PROJECT_ROOT, 'dist', 'main.js');
  if (!fs.existsSync(mainJs)) {
    console.error('Error: dist/main.js not found. Run "npm run build" first.');
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

  console.log(`\nInstalled ${copied} item(s) to: ${pluginDir}`);
  console.log('Restart Obsidian (or reload plugins) to pick up changes.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
