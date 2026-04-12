/**
 * Batch operations for the extraction pipeline.
 *
 * Provides:
 * 1. Extract all documents at once (full re-extraction)
 * 2. Re-extract after template changes (regenerate markdown from cache)
 * 3. Extract specific documents by UUID
 * 4. Clear and rebuild all output files
 *
 * Each operation reports progress via a callback for UI integration.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  runExtractionPipeline,
  type PipelineRunResult,
  type PipelineProgressCallback,
} from './extraction-pipeline';
import type { PipelineConfig } from './types';
import { logger } from '../utils/logger';

/** Options for batch extraction. */
export interface BatchExtractionOptions {
  /** Path to the synced xochitl directory. */
  xochitlPath: string;
  /** Path to output markdown files. */
  outputPath: string;
  /** Optional template path. */
  template: string | null;
}

/** Result of a batch operation. */
export interface BatchOperationResult {
  /** The operation that was performed. */
  operation: 'extract-all' | 're-extract' | 'extract-selected' | 'clear-rebuild';
  /** Pipeline result from extraction (null for clear-only operations). */
  pipelineResult: PipelineRunResult | null;
  /** Number of files cleaned up (for clear/rebuild operations). */
  filesCleanedUp: number;
  /** Whether the operation completed successfully. */
  success: boolean;
  /** Error message if the operation failed. */
  error: string | null;
  /** Duration of the operation in milliseconds. */
  durationMs: number;
}

/**
 * Extract all documents, ignoring incremental timestamps.
 *
 * This performs a full extraction of every document in the xochitl
 * directory, useful when:
 * - Setting up for the first time
 * - The output folder was deleted
 * - The extraction pipeline was updated with bug fixes
 *
 * @param options - Batch extraction configuration.
 * @param progress - Optional progress callback.
 * @returns Batch operation result.
 */
export async function extractAll(
  options: BatchExtractionOptions,
  progress?: PipelineProgressCallback,
): Promise<BatchOperationResult> {
  const startTime = Date.now();
  logger.info('Batch operation: extract all documents');

  const config: PipelineConfig = {
    xochitlPath: options.xochitlPath,
    outputPath: options.outputPath,
    template: options.template,
    sinceTimestamp: null, // No incremental filter -- extract everything
    overwrite: true, // Overwrite existing files for a clean extraction
  };

  try {
    const pipelineResult = await runExtractionPipeline(config, undefined, progress);
    return {
      operation: 'extract-all',
      pipelineResult,
      filesCleanedUp: 0,
      success: true,
      error: null,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Batch extract-all failed: ${msg}`);
    return {
      operation: 'extract-all',
      pipelineResult: null,
      filesCleanedUp: 0,
      success: false,
      error: msg,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Re-extract all documents after template changes.
 *
 * Overwrites existing markdown files with the new template format.
 * This is the same as extractAll but semantically indicates the reason
 * is a template change.
 *
 * @param options - Batch extraction configuration.
 * @param progress - Optional progress callback.
 * @returns Batch operation result.
 */
export async function reExtractWithTemplate(
  options: BatchExtractionOptions,
  progress?: PipelineProgressCallback,
): Promise<BatchOperationResult> {
  const startTime = Date.now();
  logger.info('Batch operation: re-extract with updated template');

  const config: PipelineConfig = {
    xochitlPath: options.xochitlPath,
    outputPath: options.outputPath,
    template: options.template,
    sinceTimestamp: null,
    overwrite: true, // Force overwrite to apply new template
  };

  try {
    const pipelineResult = await runExtractionPipeline(config, undefined, progress);
    return {
      operation: 're-extract',
      pipelineResult,
      filesCleanedUp: 0,
      success: true,
      error: null,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Batch re-extract failed: ${msg}`);
    return {
      operation: 're-extract',
      pipelineResult: null,
      filesCleanedUp: 0,
      success: false,
      error: msg,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Extract specific documents by UUID.
 *
 * Runs the pipeline once with UUID pre-filtering so only the selected
 * documents are discovered, extracted, and rendered. This avoids the
 * O(N * M) cost of running the full pipeline per UUID.
 *
 * @param options - Batch extraction configuration.
 * @param documentUuids - Array of document UUIDs to extract.
 * @param progress - Optional progress callback.
 * @returns Batch operation result.
 */
export async function extractSelected(
  options: BatchExtractionOptions,
  documentUuids: string[],
  progress?: PipelineProgressCallback,
): Promise<BatchOperationResult> {
  const startTime = Date.now();
  logger.info(`Batch operation: extract ${documentUuids.length} selected document(s)`);

  if (documentUuids.length === 0) {
    return {
      operation: 'extract-selected',
      pipelineResult: null,
      filesCleanedUp: 0,
      success: true,
      error: null,
      durationMs: Date.now() - startTime,
    };
  }

  const config: PipelineConfig = {
    xochitlPath: options.xochitlPath,
    outputPath: options.outputPath,
    template: options.template,
    sinceTimestamp: null,
    overwrite: true,
    uuidFilter: documentUuids,
  };

  try {
    const pipelineResult = await runExtractionPipeline(config, undefined, progress);
    return {
      operation: 'extract-selected',
      pipelineResult,
      filesCleanedUp: 0,
      success: true,
      error: null,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Batch extract-selected failed: ${msg}`);
    return {
      operation: 'extract-selected',
      pipelineResult: null,
      filesCleanedUp: 0,
      success: false,
      error: msg,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Clear all output files and re-extract everything from scratch.
 *
 * This is a destructive operation that:
 * 1. Removes all .md files from the output directory
 * 2. Runs a full extraction
 *
 * Useful when output files are in an inconsistent state.
 *
 * @param options - Batch extraction configuration.
 * @param progress - Optional progress callback.
 * @returns Batch operation result.
 */
export async function clearAndRebuild(
  options: BatchExtractionOptions,
  progress?: PipelineProgressCallback,
): Promise<BatchOperationResult> {
  const startTime = Date.now();
  logger.info('Batch operation: clear and rebuild all output');

  let filesCleanedUp = 0;

  // Phase 1: Clean up existing output files
  try {
    filesCleanedUp = cleanOutputDirectory(options.outputPath);
    logger.info(`Cleaned up ${filesCleanedUp} file(s) from ${options.outputPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to clean output directory: ${msg}`);
    return {
      operation: 'clear-rebuild',
      pipelineResult: null,
      filesCleanedUp,
      success: false,
      error: `Cleanup failed: ${msg}`,
      durationMs: Date.now() - startTime,
    };
  }

  // Phase 2: Full re-extraction
  const config: PipelineConfig = {
    xochitlPath: options.xochitlPath,
    outputPath: options.outputPath,
    template: options.template,
    sinceTimestamp: null,
    overwrite: true,
  };

  try {
    const pipelineResult = await runExtractionPipeline(config, undefined, progress);
    return {
      operation: 'clear-rebuild',
      pipelineResult,
      filesCleanedUp,
      success: true,
      error: null,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Batch clear-rebuild extraction failed: ${msg}`);
    return {
      operation: 'clear-rebuild',
      pipelineResult: null,
      filesCleanedUp,
      success: false,
      error: msg,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Remove all .md files from the output directory.
 *
 * Only removes markdown files (not subdirectories or SVG attachments).
 * Returns the number of files removed.
 */
function cleanOutputDirectory(outputPath: string): number {
  if (!fs.existsSync(outputPath)) {
    return 0;
  }

  const entries = fs.readdirSync(outputPath);
  let removed = 0;

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const fullPath = path.join(outputPath, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    fs.unlinkSync(fullPath);
    removed++;
    logger.debug(`Removed: ${fullPath}`);
  }

  return removed;
}
