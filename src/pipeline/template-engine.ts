/**
 * Handlebars/Mustache-style template engine for highlight notes.
 *
 * Supports the following template variables:
 *   {{title}}       -- Document title (visibleName)
 *   {{author}}      -- Document author (from metadata or "Unknown")
 *   {{highlights}}  -- Rendered highlight blocks
 *   {{date}}        -- Date of extraction (YYYY-MM-DD)
 *   {{source_pdf}}  -- Source PDF filename
 *   {{page}}        -- Page number (within highlight iteration)
 *   {{tags}}        -- Tags as YAML list or inline
 *   {{uuid}}        -- Document UUID
 *   {{highlight_count}} -- Total number of highlights
 *
 * Block helpers:
 *   {{#each highlights}} ... {{/each}} -- Iterate over highlights
 *   {{#if highlights}} ... {{/if}}     -- Conditional rendering
 *
 * The engine is intentionally simple -- no external dependencies.
 * Templates are stored in the vault for version control.
 *
 * Privacy: Pure computation, no network calls.
 */

import type { ExtractionResult, ExtractedHighlight, PageDrawings, MarkdownRenderer } from './types';
import type { PdfLinkFormat } from '../plugin/settings';
import { formatPdfLink, formatHighlightDate, updateFrontmatterHighlightCount } from './render-helpers';
import { logger } from '../utils/logger';

// Re-exported for backwards compatibility (public API / tests import it here).
export { formatPdfLink };
import {
  HIGHLIGHTS_SECTION_START,
  HIGHLIGHTS_SECTION_END,
  findHighlightsStart,
  findHighlightsEnd,
} from '../plugin/highlight-markers';

/** Per-page data structure used by {{#each pages}} template blocks. */
export interface PageTemplateEntry {
  page_number: number;
  highlights: HighlightTemplateContext[];
  annotation: string | null;
}

/** Variables available in the template context. */
export interface TemplateContext {
  title: string;
  author: string;
  date: string;
  source_pdf: string;
  source_type: string;
  uuid: string;
  highlight_count: number;
  tags: string[];
  highlights: HighlightTemplateContext[];
  annotations: string;
  _pages: PageTemplateEntry[];
  /** Label of the sync source (for multi-source identification). */
  source: string;
}

/** Variables available within an {{#each highlights}} block. */
export interface HighlightTemplateContext {
  text: string;
  page: number;
  color: string;
  pdf_link: string;
  created_at: string;
}

/**
 * Build a template context from an ExtractionResult.
 */
export function buildTemplateContext(
  result: ExtractionResult,
  sourcePdfName: string,
  pdfLinkFormat: PdfLinkFormat,
  tags: string[],
  author?: string,
  sourceLabel?: string,
): TemplateContext {
  // Use the document's lastModified timestamp for a deterministic date that
  // won't conflict when the same vault is synced across multiple machines.
  const now = formatHighlightDate(result.document.lastModified);

  return {
    title: result.document.visibleName,
    author: author ?? 'Unknown',
    date: now,
    source_pdf: sourcePdfName,
    source_type: 'pdf',
    uuid: result.document.uuid,
    highlight_count: result.highlights.length,
    tags,
    highlights: result.highlights.map((h) => ({
      text: h.text,
      page: h.pageNumber,
      color: h.color ?? 'yellow',
      pdf_link: formatPdfLink(sourcePdfName, h.pageNumber, pdfLinkFormat),
      created_at: h.createdAt
        ? new Date(h.createdAt).toISOString().split('T')[0]
        : now,
    })),
    annotations: '',
    _pages: [],
    source: sourceLabel ?? '',
  };
}


/**
 * Render a template string with the given context.
 *
 * Processes:
 * 1. {{#each highlights}} ... {{/each}} blocks
 * 2. {{#if variable}} ... {{/if}} conditionals
 * 3. Simple {{variable}} substitution
 * 4. {{tags_yaml}} -- tags as YAML list lines
 * 5. {{tags_inline}} -- tags as comma-separated string
 */
export function renderTemplate(
  template: string,
  context: TemplateContext,
): string {
  let output = template;

  // Process {{#each highlights}} ... {{/each}}
  output = processEachBlocks(output, context);

  // Process {{#if ...}} ... {{/if}}
  output = processIfBlocks(output, context);

  // Process simple variable substitutions
  output = substituteVariables(output, context);

  return output;
}

/**
 * Process {{#each highlights}} ... {{/each}} blocks.
 *
 * Within the block, highlight-level variables are available:
 *   {{text}}, {{page}}, {{color}}, {{pdf_link}}, {{created_at}}
 */
function processEachBlocks(template: string, context: TemplateContext): string {
  let output = template;

  // Process {{#each pages}} ... {{/each_pages}} — uses distinct closing tag to avoid nesting issues
  const pagesRegex = /\{\{#each\s+pages\}\}([\s\S]*?)\{\{\/each_pages\}\}/g;
  output = output.replace(pagesRegex, (_match, pageBody: string) => {
    const pages = context._pages;

    if (!pages || pages.length === 0) {
      return '_No highlights or annotations found._';
    }

    return pages.map((page) => {
      let rendered = pageBody;

      rendered = rendered.replace(/\{\{page_number\}\}/g, String(page.page_number));
      rendered = rendered.replace(/\{\{annotation\}\}/g, page.annotation ?? '');

      // Process nested {{#each highlights}} within the page
      const innerRegex = /\{\{#each\s+highlights\}\}([\s\S]*?)\{\{\/each\}\}/g;
      rendered = rendered.replace(innerRegex, (_m, hlBody: string) => {
        if (page.highlights.length === 0) return '';
        return page.highlights.map((h, idx) => {
          let r = hlBody;
          r = r.replace(/\{\{text\}\}/g, h.text);
          r = r.replace(/\{\{page\}\}/g, String(h.page));
          r = r.replace(/\{\{color\}\}/g, h.color);
          r = r.replace(/\{\{pdf_link\}\}/g, h.pdf_link);
          r = r.replace(/\{\{created_at\}\}/g, h.created_at);
          r = r.replace(/\{\{index\}\}/g, String(idx + 1));
          return r;
        }).join('\n');
      });

      // Process {{#if annotation}} within the page
      const ifRegex = /\{\{#if\s+annotation\}\}([\s\S]*?)\{\{\/if\}\}/g;
      rendered = rendered.replace(ifRegex, (_m, body: string) => {
        return page.annotation ? body : '';
      });

      return rendered;
    }).join('\n');
  });

  // Process {{#each highlights}} (flat, non-page-grouped) — backwards compatible
  const eachRegex = /\{\{#each\s+highlights\}\}([\s\S]*?)\{\{\/each\}\}/g;
  output = output.replace(eachRegex, (_match, body: string) => {
    if (context.highlights.length === 0) {
      return '_No highlights found._';
    }

    return context.highlights
      .map((h, idx) => {
        let rendered = body;
        rendered = rendered.replace(/\{\{text\}\}/g, h.text);
        rendered = rendered.replace(/\{\{page\}\}/g, String(h.page));
        rendered = rendered.replace(/\{\{color\}\}/g, h.color);
        rendered = rendered.replace(/\{\{pdf_link\}\}/g, h.pdf_link);
        rendered = rendered.replace(/\{\{created_at\}\}/g, h.created_at);
        rendered = rendered.replace(/\{\{index\}\}/g, String(idx + 1));
        return rendered;
      })
      .join('\n');
  });

  return output;
}

/**
 * Process {{#if variable}} ... {{/if}} conditionals.
 *
 * Supports:
 *   {{#if highlights}} -- truthy if highlights array is non-empty
 *   {{#if author}} -- truthy if author is non-empty and not "Unknown"
 *   {{#if tags}} -- truthy if tags array is non-empty
 */
function processIfBlocks(template: string, context: TemplateContext): string {
  const ifRegex = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;

  return template.replace(ifRegex, (_match, variable: string, body: string) => {
    let truthy = false;

    switch (variable) {
      case 'highlights':
        truthy = context.highlights.length > 0;
        break;
      case 'author':
        truthy = context.author !== '' && context.author !== 'Unknown';
        break;
      case 'tags':
        truthy = context.tags.length > 0;
        break;
      default:
        // Check if the variable exists and is truthy in the context
        truthy = Boolean((context as unknown as Record<string, unknown>)[variable]);
    }

    return truthy ? body : '';
  });
}

/**
 * Substitute simple {{variable}} placeholders with context values.
 */
function substituteVariables(template: string, context: TemplateContext): string {
  let output = template;

  // Direct scalar substitutions
  output = output.replace(/\{\{title\}\}/g, context.title);
  output = output.replace(/\{\{author\}\}/g, context.author);
  output = output.replace(/\{\{date\}\}/g, context.date);
  output = output.replace(/\{\{source_pdf\}\}/g, context.source_pdf);
  output = output.replace(/\{\{source_type\}\}/g, context.source_type ?? 'pdf');
  output = output.replace(/\{\{uuid\}\}/g, context.uuid);
  output = output.replace(/\{\{highlight_count\}\}/g, String(context.highlight_count));
  // {{source}} — sync source label (for multi-source setups)
  output = output.replace(/\{\{source\}\}/g, context.source ?? '');
  // {{annotations}} — page drawings rendered as image embeds
  output = output.replace(/\{\{annotations\}\}/g, context.annotations ?? '');

  // Tags as YAML list (for frontmatter)
  output = output.replace(/\{\{tags_yaml\}\}/g, () => {
    if (context.tags.length === 0) return '[]';
    return context.tags.map((t) => `  - ${t}`).join('\n');
  });

  // Tags as inline comma-separated
  output = output.replace(/\{\{tags_inline\}\}/g, context.tags.join(', '));

  // Tags as hashtags
  output = output.replace(/\{\{tags_hashtags\}\}/g, () => {
    return context.tags.map((t) => `#${t}`).join(' ');
  });

  return output;
}

// -------------------------------------------------------------------
// Default template
// -------------------------------------------------------------------

/**
 * The default template that ships with the plugin.
 *
 * This produces dataview-compatible frontmatter and groups highlights
 * as blockquotes with PDF++ links. It mirrors the output of the
 * existing DefaultMarkdownRenderer but is now configurable.
 */
export const DEFAULT_TEMPLATE = `---
title: "{{title}}"
source_pdf: "[[{{source_pdf}}]]"
source_type: {{source_type}}
date_highlighted: {{date}}
highlight_count: {{highlight_count}}
remarkable_uuid: {{uuid}}
---

<!-- eink-sync:start -->
{{#each pages}}
### Page {{page_number}}

{{#each highlights}}
> {{text}}
> -- {{pdf_link}}
<!-- notes -->
<!-- /notes -->

{{/each}}
{{#if annotation}}
![[{{annotation}}|500]]
<!-- notes -->
<!-- /notes -->
{{/if}}

{{/each_pages}}
<!-- eink-sync:end -->

`;

/**
 * Validate that a template string contains the required markers
 * for incremental update support.
 */
export function validateTemplate(template: string): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (!template.includes('{{title}}')) {
    warnings.push('Template is missing {{title}} variable.');
  }

  if (!template.includes('{{#each highlights}}')) {
    warnings.push('Template is missing {{#each highlights}} block. Highlights will not be rendered.');
  }

  if (!template.includes('eink-sync:start') && !template.includes('remarkable-bridge:start')) {
    warnings.push(
      'Template is missing the highlights section markers. ' +
      'Incremental updates will not work correctly.',
    );
  }

  return {
    valid: warnings.length === 0,
    warnings,
  };
}

/**
 * TemplateMarkdownRenderer: renders extraction results using a
 * configurable template string.
 *
 * This replaces the hardcoded DefaultMarkdownRenderer when a custom
 * template is provided in settings.
 */
export class TemplateMarkdownRenderer implements MarkdownRenderer {
  private template: string;
  private pdfLinkFormat: PdfLinkFormat;
  private tags: string[];
  private sourceLabel?: string;
  private includeColors: boolean;
  private groupByPage: boolean;

  constructor(
    template: string,
    pdfLinkFormat: PdfLinkFormat = 'pdfpp',
    tags: string[] = [],
    sourceLabel?: string,
    includeColors = true,
    groupByPage = true,
  ) {
    this.template = template;
    this.pdfLinkFormat = pdfLinkFormat;
    this.tags = tags;
    this.sourceLabel = sourceLabel;
    this.includeColors = includeColors;
    this.groupByPage = groupByPage;
  }

  /**
   * Render a full markdown note from extraction results using the template.
   * If pageDrawings are provided, they are appended after each page's
   * highlights within the managed section.
   */
  render(result: ExtractionResult, sourcePdfName?: string, pageDrawings?: PageDrawings | null): string {
    const pdfName = sourcePdfName ?? `${result.document.visibleName}.pdf`;
    // Merge default tags with document-level tags, deduplicating
    const allTags = [...new Set([...this.tags, ...(result.tags ?? [])])];
    const context = buildTemplateContext(
      result,
      pdfName,
      this.pdfLinkFormat,
      allTags,
      undefined,
      this.sourceLabel,
    );

    // Strip color info when includeColors is disabled
    if (!this.includeColors) {
      for (const h of context.highlights) {
        h.color = '';
      }
    }

    // Set source_type based on document type
    context.source_type = result.document.type === 'notebook' ? 'notebook' : 'pdf';

    // Build per-page data structure for {{#each pages}} template blocks
    const allPageNums = new Set<number>();
    for (const h of context.highlights) allPageNums.add(h.page);
    if (pageDrawings) {
      for (const p of pageDrawings.keys()) allPageNums.add(p);
    }

    const pages = [...allPageNums].sort((a, b) => a - b).map((pageNum) => ({
      page_number: pageNum,
      highlights: context.highlights.filter((h) => h.page === pageNum),
      annotation: pageDrawings?.get(pageNum) ?? null,
    }));
    context._pages = pages;

    // Also set {{annotations}} for simple templates
    if (pageDrawings && pageDrawings.size > 0) {
      const lines: string[] = [];
      for (const [pageNum, filename] of [...pageDrawings.entries()].sort((a, b) => a[0] - b[0])) {
        lines.push(`**Page ${pageNum}:**`);
        lines.push(`![[${filename}|500]]`);
        lines.push('');
      }
      context.annotations = lines.join('\n');
    }

    const rendered = renderTemplate(this.template, context);

    // Clean up excessive blank lines
    return rendered.replace(/\n{3,}/g, '\n\n');
  }

  /**
   * Merge new extraction results into an existing note.
   *
   * Uses the same marker-based strategy as DefaultMarkdownRenderer:
   * replace content between the markers, preserve everything else.
   */
  mergeWithExisting(
    existingContent: string,
    result: ExtractionResult,
    sourcePdfName: string,
    pageDrawings?: PageDrawings | null,
  ): string {
    const start = findHighlightsStart(existingContent);
    const end = findHighlightsEnd(existingContent);

    // Render fresh content
    const fresh = this.render(result, sourcePdfName, pageDrawings);

    if (!start || !end) {
      // No markers — use fresh render
      return fresh;
    }

    // Extract user notes from the existing section (using whichever marker pair was found)
    const existingSection = existingContent.substring(
      start.index, end.index + end.marker.length
    );
    const preservedNotes = extractNoteBlocks(existingSection);

    // Get the new section from the fresh render (always uses current markers)
    const newStartIdx = fresh.indexOf(HIGHLIGHTS_SECTION_START);
    const newEndIdx = fresh.indexOf(HIGHLIGHTS_SECTION_END);
    if (newStartIdx === -1 || newEndIdx === -1) {
      return fresh;
    }
    let newSection = fresh.substring(
      newStartIdx, newEndIdx + HIGHLIGHTS_SECTION_END.length
    );

    // Re-insert preserved notes positionally
    // The Nth <!-- notes --><!-- /notes --> in the new section gets the Nth preserved note
    let noteIdx = 0;
    newSection = newSection.replace(/<!-- notes -->\s*<!-- \/notes -->/g, (match) => {
      if (noteIdx < preservedNotes.length && preservedNotes[noteIdx]) {
        const content = preservedNotes[noteIdx];
        noteIdx++;
        return `<!-- notes -->\n${content}\n<!-- /notes -->`;
      }
      noteIdx++;
      return match;
    });

    // Reassemble: before markers + new section + after markers
    const before = existingContent.substring(0, start.index);
    const after = existingContent.substring(end.index + end.marker.length);

    const updatedBefore = updateFrontmatterHighlightCount(before, result.highlights.length);

    return updatedBefore + newSection + after;
  }

}

/**
 * Extract user-written notes from %%note%%...%%/note%% and
 * %%page-note%%...%%/page-note%% marker pairs in existing content.
 *
 * Notes are identified by their position (Nth %%note%% block = index N).
 * Returns an array of { marker, content } where marker is the opening tag
 * to search for when re-inserting.
 */
/**
 * Extract user notes from <!-- notes --> ... <!-- /notes --> pairs.
 * Returns array of note content strings indexed by position.
 */
function extractNoteBlocks(section: string): string[] {
  const notes: string[] = [];
  const regex = /<!-- notes -->([\s\S]*?)<!-- \/notes -->/g;
  let match;
  while ((match = regex.exec(section)) !== null) {
    notes.push(match[1].trim());
  }
  return notes;
}
