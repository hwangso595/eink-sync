/**
 * Tests for the XochitlFileWatcher.
 *
 * Tests the watcher lifecycle, debouncing, and event emission.
 * Uses a real temporary directory for filesystem operations.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { XochitlFileWatcher, FileWatcherEvent } from './file-watcher';

/** Create a temporary directory for testing. */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xochitl-watcher-test-'));
}

/** Clean up a temporary directory. */
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors in tests
  }
}

describe('XochitlFileWatcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('constructor', () => {
    it('creates a watcher with default config', () => {
      const watcher = new XochitlFileWatcher({ xochitlPath: tempDir });
      expect(watcher.isRunning()).toBe(false);
      expect(watcher.getPendingChangeCount()).toBe(0);
      expect(watcher.getLastTriggerTimestamp()).toBeNull();
    });
  });

  describe('start/stop', () => {
    it('starts and stops without error', () => {
      const watcher = new XochitlFileWatcher({ xochitlPath: tempDir });
      watcher.start();
      expect(watcher.isRunning()).toBe(true);
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('emits started and stopped events', () => {
      const events: FileWatcherEvent[] = [];
      const watcher = new XochitlFileWatcher({ xochitlPath: tempDir });
      watcher.on((event) => events.push(event));

      watcher.start();
      watcher.stop();

      expect(events).toContain('started');
      expect(events).toContain('stopped');
    });

    it('throws when directory does not exist', () => {
      const watcher = new XochitlFileWatcher({
        xochitlPath: '/nonexistent/path',
      });
      expect(() => watcher.start()).toThrow('Watch directory does not exist');
    });

    it('emits error when directory does not exist', () => {
      const events: { event: FileWatcherEvent; detail?: string }[] = [];
      const watcher = new XochitlFileWatcher({
        xochitlPath: '/nonexistent/path',
      });
      watcher.on((event, detail) => events.push({ event, detail }));

      try {
        watcher.start();
      } catch {
        // Expected
      }

      expect(events.some((e) => e.event === 'error')).toBe(true);
    });

    it('does not throw when start called twice', () => {
      const watcher = new XochitlFileWatcher({ xochitlPath: tempDir });
      watcher.start();
      expect(() => watcher.start()).not.toThrow();
      watcher.stop();
    });

    it('does not throw when stop called without start', () => {
      const watcher = new XochitlFileWatcher({ xochitlPath: tempDir });
      expect(() => watcher.stop()).not.toThrow();
    });
  });

  describe('file change detection', () => {
    it('detects .rm file changes', (done) => {
      const watcher = new XochitlFileWatcher({
        xochitlPath: tempDir,
        debounceMs: 100,
      });

      watcher.on((event) => {
        if (event === 'change-detected') {
          watcher.stop();
          done();
        }
      });

      watcher.start();

      // Write a .rm file to trigger the watcher
      setTimeout(() => {
        fs.writeFileSync(path.join(tempDir, 'test-page.rm'), 'test data');
      }, 50);
    }, 5000);

    it('ignores non-watched extensions', (done) => {
      const watcher = new XochitlFileWatcher({
        xochitlPath: tempDir,
        debounceMs: 200,
      });

      let changeDetected = false;
      watcher.on((event) => {
        if (event === 'change-detected') {
          changeDetected = true;
        }
      });

      watcher.start();

      // Write a .pdf file (not watched by default)
      setTimeout(() => {
        fs.writeFileSync(path.join(tempDir, 'large-file.pdf'), 'pdf data');
      }, 50);

      // Check after debounce would have fired
      setTimeout(() => {
        watcher.stop();
        expect(changeDetected).toBe(false);
        done();
      }, 400);
    }, 5000);

    it('fires extraction-due after debounce settles', (done) => {
      const watcher = new XochitlFileWatcher({
        xochitlPath: tempDir,
        debounceMs: 200,
      });

      watcher.on((event) => {
        if (event === 'extraction-due') {
          expect(watcher.getLastTriggerTimestamp()).not.toBeNull();
          watcher.stop();
          done();
        }
      });

      watcher.start();

      setTimeout(() => {
        fs.writeFileSync(path.join(tempDir, 'page1.rm'), 'data');
      }, 50);
    }, 5000);

    it('resets debounce on rapid changes', (done) => {
      const watcher = new XochitlFileWatcher({
        xochitlPath: tempDir,
        debounceMs: 300,
      });

      let extractionDueCount = 0;
      watcher.on((event) => {
        if (event === 'extraction-due') {
          extractionDueCount++;
        }
      });

      watcher.start();

      // Write files rapidly (within debounce window)
      setTimeout(() => {
        fs.writeFileSync(path.join(tempDir, 'page1.rm'), 'data1');
      }, 50);
      setTimeout(() => {
        fs.writeFileSync(path.join(tempDir, 'page2.rm'), 'data2');
      }, 150);

      // Check: should only fire once after both changes settle
      setTimeout(() => {
        watcher.stop();
        expect(extractionDueCount).toBe(1);
        done();
      }, 700);
    }, 5000);
  });

  describe('on/off', () => {
    it('removes listener with off', () => {
      const watcher = new XochitlFileWatcher({ xochitlPath: tempDir });
      const events: FileWatcherEvent[] = [];
      const listener = (event: FileWatcherEvent) => events.push(event);

      watcher.on(listener);
      watcher.start();
      watcher.off(listener);
      watcher.stop();

      // Should have 'started' but not 'stopped' since we removed the listener
      expect(events).toContain('started');
      expect(events).not.toContain('stopped');
    });
  });
});
