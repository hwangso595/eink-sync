import * as fs from 'fs';
import * as path from 'path';
import { parse, stringify } from 'yaml';
import { repairNoteFrontmatter } from './frontmatter';
import { DEFAULT_TEMPLATE, renderTemplate, TemplateContext, TemplateMarkdownRenderer } from './template-engine';
import { DefaultMarkdownRenderer } from './markdown-renderer';
import { updateFrontmatterHighlightCount } from './render-helpers';
import type { ExtractionResult } from './types';

const context: TemplateContext = {
  title: 'Test document', author: 'Unknown', date: '2026-09-26',
  source_pdf: 'test.pdf', source_type: 'notebook', uuid: 'test-uuid',
  highlight_count: 0, tags: [], highlights: [], annotations: '', _pages: [], source: '',
};
const result: ExtractionResult = {
  document: {
    uuid: context.uuid, visibleName: context.title, parentUuid: '', type: 'notebook',
    lastModified: Date.UTC(2026, 8, 26), pageCount: 1, pageUuids: ['page-1'], hasPdf: false,
  },
  highlights: [], tags: [], warnings: [], formatDetected: 'v6',
  success: true, error: null, extractedAt: '2026-09-26T00:00:00Z',
};
const damagedHeader = [
  '---', 'title: "Test document"',
  'source_type:', '  "{ source_type }":',
  'date_highlighted:', '  "{ date }":',
  'highlight_count:', '  "{ highlight_count }":',
  'remarkable_uuid:', '  "{ uuid }":',
  'tags:', '{{tags_yaml}}', '---',
].join('\n');

function properties(markdown: string): Record<string, unknown> {
  const header = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  expect(header).not.toBeNull();
  return parse(header![1]) as Record<string, unknown>;
}

describe('Properties YAML', () => {
  const tagValues = [[], [''], ['  ', '\t'], ['ml', 'linear algebra'],
    ['#tag', 'true', 'null', '2026', 'a: b', 'a # b', '"quoted"', 'a\\b', 'line\nbreak']];
  const tagTemplates = ['tags: {{tags_yaml}}', 'tags:\n{{tags_yaml}}', 'tags: "{{tags_yaml}}"', 'tags:\n  {{tags_yaml}}'];

  for (const template of tagTemplates) {
    it.each(tagValues.map((tags) => [tags]))(`parses ${JSON.stringify(template)} with tags %j`, (tags) => {
      const rendered = renderTemplate(`---\n${template}\n---\nBody`, { ...context, tags });
      expect(properties(rendered).tags).toEqual([...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]);
      expect(rendered).toContain('\nBody');
    });
  }

  it('renders the actual shape of Obsidian-rewritten placeholders as scalar properties', () => {
    const rendered = renderTemplate(damagedHeader, context);
    expect(properties(rendered)).toEqual({
      title: context.title, source_type: 'notebook', date_highlighted: context.date,
      highlight_count: 0, remarkable_uuid: context.uuid, tags: [],
    });
  });

  it('quotes template metadata safely while preserving body text and literal replacement tokens', () => {
    const title = 'A "quote": \\path\nNext $& $\' {{uuid}}';
    const source = 'A "PDF".pdf';
    const rendered = renderTemplate(DEFAULT_TEMPLATE + '\n# {{title}}', { ...context, title, source_pdf: source });
    expect(properties(rendered).title).toBe(title);
    expect(properties(rendered).source_pdf).toBe(`[[${source}]]`);
    expect(properties(rendered).highlight_count).toBe(0);
    expect(rendered).toContain(`# ${title}`);
  });

  it('ships templates whose placeholders survive a YAML read/write cycle', () => {
    for (const template of [DEFAULT_TEMPLATE, fs.readFileSync(path.join(__dirname, '../../templates/remarkable-highlight.md'), 'utf8')]) {
      const fields = properties(template);
      expect(fields.remarkable_uuid).toBe('{{uuid}}');
      expect(fields.highlight_count).toBe('{{highlight_count}}');
      const roundTripped = template.replace(/^(---\r?\n)[\s\S]*?(\r?\n---)/, (_match, start: string, end: string) => start + stringify(fields).trimEnd() + end);
      const rendered = renderTemplate(roundTripped, context);
      expect(properties(rendered).remarkable_uuid).toBe(context.uuid);
      expect(properties(rendered).highlight_count).toBe(0);
    }
  });

  it.each(tagValues.map((tags) => [tags]))('keeps default-renderer tag values as strings: %j', (tags) => {
    const rendered = new DefaultMarkdownRenderer().render({ ...result, tags });
    const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
    expect(properties(rendered).tags).toEqual(cleaned.length ? cleaned : undefined);
  });
});

describe('repairing existing properties', () => {
  it.each(['\n', '\r\n'])('repairs broken empty tags and mapped values with %j newlines', (newline) => {
    const existing = damagedHeader.replace('{{tags_yaml}}', '[]').replace(/\n/g, newline)
      + newline + 'Unchanged body';
    const repaired = repairNoteFrontmatter(existing, renderTemplate(DEFAULT_TEMPLATE, context));
    expect(properties(repaired)).toMatchObject({ source_type: 'notebook', remarkable_uuid: 'test-uuid', highlight_count: 0, tags: [] });
    expect(repaired.endsWith(newline + 'Unchanged body')).toBe(true);
  });

  it.each(['tags:', 'tags: null', 'tags:\nstatus: reading', 'tags:\n[]\nstatus: reading'])('repairs empty tags in %j', (fields) => {
    expect(properties(repairNoteFrontmatter(`---\n${fields}\n---`, '')).tags).toEqual([]);
  });

  it('preserves real tags, custom properties, and mapped user data', () => {
    const existing = '---\ntags:\n  - custom\nstatus: reading\ncustom:\n  "{ uuid }":\n---\nBody';
    expect(repairNoteFrontmatter(existing, renderTemplate(DEFAULT_TEMPLATE, context))).toBe(existing);
  });

  it('updates counts only in frontmatter, including Windows line endings', () => {
    const existing = '---\r\nhighlight_count: 1\r\n---\r\nhighlight_count: 99';
    expect(updateFrontmatterHighlightCount(existing, 2)).toBe(existing.replace('count: 1', 'count: 2'));
    expect(updateFrontmatterHighlightCount('highlight_count: 99', 2)).toBe('highlight_count: 99');
  });

  it.each(['eink-sync', 'remarkable-bridge'])('repairs merge properties and preserves text with %s template markers', (marker) => {
    const template = `${damagedHeader}\n<!-- ${marker}:start -->\n{{tags}}\n<!-- ${marker}:end -->`;
    const renderer = new TemplateMarkdownRenderer(template);
    const existing = damagedHeader.replace('{{tags_yaml}}', '[]').replace('\n---', '\nstatus: reading\n---')
      + `\nMy introduction\n<!-- ${marker}:start -->\nOld content\n<!-- ${marker}:end -->\nMy references`;
    const merged = renderer.mergeWithExisting(existing, { ...result, tags: ['new'] }, 'test.pdf');
    expect(properties(merged)).toMatchObject({ remarkable_uuid: 'test-uuid', highlight_count: 0, tags: [], status: 'reading' });
    expect(merged).toContain('My introduction');
    expect(merged).toContain('My references');
    expect(merged).toContain('<!-- eink-sync:start -->\n#new\n<!-- eink-sync:end -->');
    expect(merged).not.toContain('Old content');
  });

  it('repairs properties when merging through the default renderer', () => {
    const existing = damagedHeader.replace('{{tags_yaml}}', '[]')
      + '\n<!-- eink-sync:start -->\nOld\n<!-- eink-sync:end -->\nMy references';
    const merged = new DefaultMarkdownRenderer().mergeWithExisting(existing, result, 'test.pdf');
    expect(properties(merged)).toMatchObject({ remarkable_uuid: 'test-uuid', highlight_count: 0, tags: [] });
    expect(merged).toContain('My references');
  });
});
