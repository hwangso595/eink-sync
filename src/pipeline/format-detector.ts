/**
 * Detect the .rm file format version from file header bytes.
 *
 * Per the spec, format detection is per-document based on header bytes:
 * - v6 files start with "reMarkable .lines file, version=6"
 * - v5 files start with "reMarkable .lines file, version=5"
 * - v3 files start with "reMarkable .lines file, version=3"
 *
 * This module is a foundation for Sprint 3's extraction pipeline.
 */

import { RmFileFormat } from './types';
import { logger } from '../utils/logger';

/** Known header prefixes for .rm file format versions. */
const FORMAT_HEADERS: { prefix: string; format: RmFileFormat }[] = [
  { prefix: 'reMarkable .lines file, version=6', format: 'v6' },
  { prefix: 'reMarkable .lines file, version=5', format: 'v5' },
  { prefix: 'reMarkable .lines file, version=3', format: 'v3' },
];

/** Maximum bytes to read for format detection. */
const HEADER_READ_SIZE = 64;

/**
 * Detect the .rm file format from the first bytes of a file.
 *
 * @param headerBytes - First 64+ bytes of the .rm file.
 * @returns The detected format, or 'unknown' if no match.
 */
export function detectRmFormat(headerBytes: Buffer): RmFileFormat {
  const headerStr = headerBytes.toString('ascii', 0, Math.min(headerBytes.length, HEADER_READ_SIZE));

  for (const { prefix, format } of FORMAT_HEADERS) {
    if (headerStr.startsWith(prefix)) {
      logger.debug(`Detected .rm format: ${format}`);
      return format;
    }
  }

  logger.warn(`Unknown .rm file format. Header: "${headerStr.substring(0, 40)}..."`);
  return 'unknown';
}

/**
 * Check whether a format is supported for highlight extraction.
 */
export function isFormatSupported(format: RmFileFormat): boolean {
  // v6 is the primary target (firmware 3.0+, rmscene parser)
  // v3 and v5 are supported via legacy parser (Sprint 3/Phase 3)
  return format === 'v6' || format === 'v5' || format === 'v3';
}

/**
 * Get the required parser library for a given format.
 */
export function getParserForFormat(format: RmFileFormat): 'rmscene' | 'legacy' | null {
  if (format === 'v6') return 'rmscene';
  if (format === 'v3' || format === 'v5') return 'legacy';
  return null;
}

/**
 * Detect format from a file path by reading the first HEADER_READ_SIZE bytes.
 *
 * @param filePath - Absolute path to a .rm file.
 * @returns The detected format, or 'unknown' if the file cannot be read.
 */
export async function detectRmFormatFromFile(filePath: string): Promise<RmFileFormat> {
  const fs = await import('fs');
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(HEADER_READ_SIZE);
    fs.readSync(fd, buffer, 0, HEADER_READ_SIZE, 0);
    fs.closeSync(fd);
    return detectRmFormat(buffer);
  } catch {
    logger.warn(`Could not read file for format detection: ${filePath}`);
    return 'unknown';
  }
}

export { HEADER_READ_SIZE };
