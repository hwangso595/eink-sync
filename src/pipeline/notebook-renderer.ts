/**
 * Render notebook documents as markdown notes with embedded SVG page images.
 *
 * For each reMarkable notebook, produces:
 * 1. A parent markdown note named after the notebook
 * 2. SVG files for each page stored in a configurable attachments folder
 * 3. Obsidian-style image embeds (![[page-1.svg]]) linking pages to the note
 *
 * For PDF documents with handwritten annotations, produces:
 * 1. Transparent-background SVG overlays for pages with drawing strokes
 * 2. Inline image embeds within the highlight note, near the page's text highlights
 *
 * Page structure in the parent note mirrors the notebook's page order.
 */

import * as path from 'path';
import { logger } from '../utils/logger';
import type { RenderedPage, StrokeRenderOutput } from './stroke-renderer-bridge';
import type { ReMarkableDocument } from './types';
import { generateOutputFilename } from './markdown-renderer';

/** Configuration for notebook rendering output. */
export interface NotebookRenderConfig {
  /** Folder within the vault for SVG attachments (relative to vault root). */
  attachmentsFolder: string;
  /** Folder within the vault for markdown notes (relative to vault root). */
  outputFolder: string;
}

/** Result of rendering a notebook to markdown + SVGs. */
export interface NotebookRenderResult {
  /** Path to the generated markdown note (relative to vault root). */
  markdownPath: string;
  /** Markdown content for the parent note. */
  markdownContent: string;
  /** Paths to generated SVG files (relative to vault root). */
  svgPaths: string[];
  /** Number of pages with renderable strokes. */
  pagesWithStrokes: number;
  /** Total page count. */
  totalPages: number;
  /** Warnings encountered during rendering. */
  warnings: string[];
}

/**
 * Generate markdown content for a notebook document.
 *
 * The note includes:
 * - YAML frontmatter with notebook metadata
 * - A heading for the notebook name
 * - One section per page with an embedded SVG image
 * - Pages without strokes are listed but marked as blank
 */
export function renderNotebookMarkdown(
  document: ReMarkableDocument,
  renderOutput: StrokeRenderOutput,
  config: NotebookRenderConfig,
): NotebookRenderResult {
  const safeName = generateOutputFilename(document.visibleName);
  const notebookAttachmentsDir = path.posix.join(
    config.attachmentsFolder,
    safeName,
  );

  // Use the document's lastModified timestamp for a deterministic date that
  // won't conflict when the same vault is synced across multiple machines.
  const now = document.lastModified > 0
    ? new Date(document.lastModified).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  const pagesWithStrokes = renderOutput.pages.filter((p) => p.hasStrokes).length;

  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`title: "${escapeYaml(document.visibleName)}"`);
  lines.push('source_type: notebook');
  lines.push(`date_rendered: ${now}`);
  lines.push(`page_count: ${renderOutput.pages.length}`);
  lines.push(`pages_with_content: ${pagesWithStrokes}`);
  lines.push(`remarkable_uuid: ${document.uuid}`);
  lines.push('tags:');
  lines.push('  - remarkable');
  lines.push('  - notebook');
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${document.visibleName}`);
  lines.push('');

  // Page listing
  const svgPaths: string[] = [];
  const warnings: string[] = [];

  if (renderOutput.pages.length === 0) {
    lines.push('_This notebook has no pages._');
  } else {
    for (const page of renderOutput.pages) {
      const pageNum = page.pageIndex + 1;
      lines.push(`## Page ${pageNum}`);
      lines.push('');

      if (page.hasStrokes && page.svgPath) {
        // Build the relative path for the Obsidian embed
        const svgFilename = `page-${pageNum}.svg`;
        const vaultRelativePath = path.posix.join(notebookAttachmentsDir, svgFilename);
        svgPaths.push(vaultRelativePath);

        lines.push(`![[${vaultRelativePath}]]`);
        lines.push('');
        lines.push(`*${page.strokeCount} strokes*`);
      } else {
        lines.push('_Blank page_');
      }

      if (page.error) {
        lines.push('');
        lines.push(`> [!warning] Rendering error`);
        lines.push(`> ${page.error}`);
        warnings.push(`Page ${pageNum}: ${page.error}`);
      }

      lines.push('');
    }
  }

  // Errors section
  if (renderOutput.errors.length > 0) {
    lines.push('## Rendering Notes');
    lines.push('');
    for (const err of renderOutput.errors) {
      lines.push(`- ${err}`);
      warnings.push(err);
    }
    lines.push('');
  }

  const markdownPath = path.posix.join(
    config.outputFolder,
    `${safeName}.md`,
  );

  return {
    markdownPath,
    markdownContent: lines.join('\n'),
    svgPaths,
    pagesWithStrokes,
    totalPages: renderOutput.pages.length,
    warnings,
  };
}

/**
 * Generate inline annotation image markup for a PDF page's handwritten strokes.
 *
 * This is used within highlight notes to show the scribble/drawing layer
 * alongside text highlights for the same page.
 *
 * @param page - The rendered page data.
 * @param attachmentsFolder - Vault-relative path to the attachments folder.
 * @param documentName - Safe filename for the document (used as subdirectory).
 * @returns Markdown string with the embedded image, or empty string if no strokes.
 */
export function renderPdfAnnotationImage(
  page: RenderedPage,
  attachmentsFolder: string,
  documentName: string,
): string {
  if (!page.hasStrokes || !page.svgPath) {
    return '';
  }

  const pageNum = page.pageIndex + 1;
  const svgFilename = `page-${pageNum}-annotations.svg`;
  const vaultPath = path.posix.join(attachmentsFolder, documentName, svgFilename);

  const lines: string[] = [];
  lines.push('');
  lines.push(`> [!note] Handwritten annotations`);
  lines.push(`> ![[${vaultPath}]]`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Escape special characters in a YAML string value.
 */
function escapeYaml(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}
