/**
 * E-Ink Sync: plugin entry point.
 *
 * Obsidian loads the default export from this module as the plugin class.
 * The plugin class is defined in ./plugin/plugin.ts and wires together the
 * sync, extraction, and UI infrastructure.
 *
 * This module intentionally re-exports nothing else. Internal modules are
 * imported directly by their consumers (and by tests) via their own paths,
 * so keeping the entry surface minimal lets esbuild tree-shake unused code
 * out of the shipped main.js.
 */

export { default } from './plugin/plugin';
