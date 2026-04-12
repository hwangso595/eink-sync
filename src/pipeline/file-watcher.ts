/**
 * File watcher for automatic extraction of new/modified .rm files.
 *
 * Monitors the synced xochitl directory for changes and triggers
 * the extraction pipeline automatically. Uses debouncing to wait
 * for sync to settle before running extraction.
 *
 * Design decisions:
 * - Uses Node.js fs.watch (recursive) rather than chokidar to avoid
 *   an additional dependency.
 * - Debounces changes with a configurable settle time (default: 10s)
 *   to handle Syncthing's incremental file transfers.
 * - Only watches for .rm and .metadata file changes (not .pdf, which
 *   are large and slow to transfer).
 * - Emits events for integration with the Obsidian plugin lifecycle.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

/** Events emitted by the file watcher. */
export type FileWatcherEvent =
  | 'change-detected'   // A relevant file changed
  | 'extraction-due'    // Debounce settled, extraction should run
  | 'error'             // Watch error (directory deleted, permissions, etc.)
  | 'started'           // Watcher started
  | 'stopped';          // Watcher stopped

/** Callback for file watcher events. */
export type FileWatcherCallback = (
  event: FileWatcherEvent,
  detail?: string,
) => void;

/** Configuration for the file watcher. */
export interface FileWatcherConfig {
  /** Path to the synced xochitl directory. */
  xochitlPath: string;
  /** Debounce time in milliseconds before triggering extraction (default: 10000). */
  debounceMs?: number;
  /** File extensions to watch (default: ['.rm', '.metadata', '.content']). */
  watchExtensions?: string[];
  /** Whether to watch recursively (default: true). */
  recursive?: boolean;
}

/** Default debounce time: 10 seconds to let Syncthing finish. */
const DEFAULT_DEBOUNCE_MS = 10_000;

/** Default file extensions to watch for changes. */
const DEFAULT_WATCH_EXTENSIONS = ['.rm', '.metadata', '.content'];

/**
 * File watcher that monitors the xochitl directory for changes.
 *
 * Usage:
 *   const watcher = new XochitlFileWatcher({
 *     xochitlPath: '/path/to/xochitl',
 *     debounceMs: 10000,
 *   });
 *   watcher.on((event, detail) => {
 *     if (event === 'extraction-due') runExtraction();
 *   });
 *   watcher.start();
 *   // ... later ...
 *   watcher.stop();
 */
export class XochitlFileWatcher {
  private config: Required<FileWatcherConfig>;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: FileWatcherCallback[] = [];
  private running = false;
  private pendingChanges = 0;
  private lastExtractionTrigger: number | null = null;

  constructor(config: FileWatcherConfig) {
    this.config = {
      xochitlPath: config.xochitlPath,
      debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      watchExtensions: config.watchExtensions ?? DEFAULT_WATCH_EXTENSIONS,
      recursive: config.recursive ?? true,
    };
  }

  /**
   * Register a callback for watcher events.
   */
  on(callback: FileWatcherCallback): void {
    this.listeners.push(callback);
  }

  /**
   * Remove a previously registered callback.
   */
  off(callback: FileWatcherCallback): void {
    this.listeners = this.listeners.filter((cb) => cb !== callback);
  }

  /**
   * Start watching the xochitl directory.
   *
   * @throws Error if the directory does not exist.
   */
  start(): void {
    if (this.running) {
      logger.warn('File watcher already running');
      return;
    }

    const watchPath = this.config.xochitlPath;
    if (!fs.existsSync(watchPath)) {
      this.emit('error', `Watch directory does not exist: ${watchPath}`);
      throw new Error(`Watch directory does not exist: ${watchPath}`);
    }

    try {
      this.watcher = fs.watch(
        watchPath,
        { recursive: this.config.recursive },
        (eventType, filename) => {
          this.handleFsEvent(eventType, filename ?? '');
        },
      );

      this.watcher.on('error', (err) => {
        logger.error(`File watcher error: ${err.message}`);
        this.emit('error', err.message);
      });

      this.running = true;
      this.pendingChanges = 0;
      logger.info(`File watcher started on ${watchPath}`);
      this.emit('started');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to start file watcher: ${msg}`);
      this.emit('error', msg);
      throw err;
    }
  }

  /**
   * Stop watching and clean up resources.
   */
  stop(): void {
    if (!this.running) return;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.running = false;
    this.pendingChanges = 0;
    logger.info('File watcher stopped');
    this.emit('stopped');
  }

  /**
   * Whether the watcher is currently active.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Number of file changes detected since last extraction trigger.
   */
  getPendingChangeCount(): number {
    return this.pendingChanges;
  }

  /**
   * Timestamp of the last extraction trigger, or null if never triggered.
   */
  getLastTriggerTimestamp(): number | null {
    return this.lastExtractionTrigger;
  }

  /**
   * Handle a raw filesystem event from fs.watch.
   */
  private handleFsEvent(_eventType: string, filename: string): void {
    if (!filename) return;

    // Ignore Syncthing temporary and conflict files
    if (filename.includes('sync-conflict') || filename.includes('.syncthing.') || filename.endsWith('.tmp')) {
      return;
    }

    // Filter by extension
    const ext = path.extname(filename).toLowerCase();
    if (!this.config.watchExtensions.includes(ext)) {
      return;
    }

    this.pendingChanges++;
    logger.debug(`File change detected: ${filename} (${this.pendingChanges} pending)`);
    this.emit('change-detected', filename);

    // Reset the debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const count = this.pendingChanges;
      this.pendingChanges = 0;
      this.lastExtractionTrigger = Date.now();
      logger.info(`Debounce settled: ${count} file change(s), triggering extraction`);
      this.emit('extraction-due', `${count} file(s) changed`);
    }, this.config.debounceMs);
  }

  /**
   * Emit an event to all registered listeners.
   */
  private emit(event: FileWatcherEvent, detail?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(event, detail);
      } catch (err) {
        logger.error(`File watcher listener error: ${err}`);
      }
    }
  }
}
