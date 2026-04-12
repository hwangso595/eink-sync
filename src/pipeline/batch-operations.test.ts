/**
 * Tests for batch operations.
 *
 * Tests the batch operation wrapper logic (options assembly, cleanup).
 * The actual pipeline execution is tested in extraction-pipeline.test.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We test the cleanOutputDirectory behavior via clearAndRebuild
// and the option assembly via extractAll/reExtractWithTemplate.

describe('batch operations', () => {
  let tempOutputDir: string;

  beforeEach(() => {
    tempOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempOutputDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('cleanOutputDirectory (via clearAndRebuild)', () => {
    it('removes .md files from output directory', async () => {
      // Create some test files
      fs.writeFileSync(path.join(tempOutputDir, 'note1.md'), '# Note 1');
      fs.writeFileSync(path.join(tempOutputDir, 'note2.md'), '# Note 2');
      fs.writeFileSync(path.join(tempOutputDir, 'image.svg'), '<svg></svg>');

      // Verify files exist
      expect(fs.readdirSync(tempOutputDir)).toHaveLength(3);

      // Import and call clearAndRebuild -- it will fail on pipeline
      // but cleanup phase will succeed
      const { clearAndRebuild } = await import('./batch-operations');
      const result = await clearAndRebuild({
        xochitlPath: '/nonexistent/xochitl',
        outputPath: tempOutputDir,
        template: null,
      });

      // Cleanup should have removed 2 .md files
      expect(result.filesCleanedUp).toBe(2);
      // Pipeline should have failed (nonexistent xochitl path)
      expect(result.success).toBe(false);
      // The SVG should still be there
      const remaining = fs.readdirSync(tempOutputDir);
      expect(remaining).toContain('image.svg');
      expect(remaining).not.toContain('note1.md');
      expect(remaining).not.toContain('note2.md');
    });
  });

  describe('extractAll', () => {
    it('returns failure for nonexistent xochitl path', async () => {
      const { extractAll } = await import('./batch-operations');
      const result = await extractAll({
        xochitlPath: '/nonexistent/xochitl',
        outputPath: tempOutputDir,
        template: null,
      });

      expect(result.operation).toBe('extract-all');
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reExtractWithTemplate', () => {
    it('returns failure for nonexistent xochitl path', async () => {
      const { reExtractWithTemplate } = await import('./batch-operations');
      const result = await reExtractWithTemplate({
        xochitlPath: '/nonexistent/xochitl',
        outputPath: tempOutputDir,
        template: null,
      });

      expect(result.operation).toBe('re-extract');
      expect(result.success).toBe(false);
    });
  });

  describe('extractSelected', () => {
    it('returns success for empty UUID list', async () => {
      const { extractSelected } = await import('./batch-operations');
      const result = await extractSelected(
        {
          xochitlPath: '/nonexistent',
          outputPath: tempOutputDir,
          template: null,
        },
        [],
      );

      expect(result.operation).toBe('extract-selected');
      expect(result.success).toBe(true);
      expect(result.pipelineResult).toBeNull();
    });
  });
});
