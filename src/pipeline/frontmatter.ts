/** YAML helpers shared by note templates and the default renderer. */

const FRONTMATTER_RE = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?=\r?\n|$))/;

/** Keep strings strings, including quotes, newlines, booleans, and numbers. */
export function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function mapFrontmatter(content: string, transform: (yaml: string) => string): string {
  return content.replace(FRONTMATTER_RE, (_match, start: string, yaml: string, end: string) => {
    return start + transform(yaml) + end;
  });
}

const PROPERTY_TOKENS: Record<string, string> = {
  title: 'title',
  author: 'author',
  source_pdf: 'source_pdf',
  source_type: 'source_type',
  date_highlighted: 'date',
  highlight_count: 'highlight_count',
  remarkable_uuid: 'uuid',
  source: 'source',
};

/** Obsidian can rewrite an unquoted {{token}} as a nested YAML mapping. */
function repairPropertyTokens(yaml: string, valueFor: (property: string, token: string) => string | undefined): string {
  return yaml.replace(
    /^(\w+):[ \t]*\r?\n[ \t]+["']\{\s*(\w+)\s*\}["']:[ \t]*(?:null)?(?=\r?$)/gm,
    (match, property: string, token: string) => {
      if (PROPERTY_TOKENS[property] !== token) return match;
      const value = valueFor(property, token);
      return value === undefined ? match : `${property}: ${value}`;
    },
  );
}

export function repairTemplateFrontmatter(template: string): string {
  return mapFrontmatter(template, (yaml) => repairPropertyTokens(yaml, (_property, token) => `"{{${token}}}"`));
}

/** Repair known generated defects without replacing user properties or text. */
export function repairNoteFrontmatter(existing: string, fresh: string): string {
  const freshYaml = fresh.match(FRONTMATTER_RE)?.[2];
  return mapFrontmatter(existing, (yaml) => {
    let repaired = repairPropertyTokens(yaml, (property) => {
      return freshYaml?.match(new RegExp(`^${property}:([^\\r\\n]+)$`, 'm'))?.[1].trim();
    });
    // Older templates emitted an unindented [] or a null tags property.
    repaired = repaired.replace(/^tags:[ \t]*\r?\n\[\][ \t]*(?=\r?$)/gm, 'tags: []');
    repaired = repaired.replace(/^tags:[ \t]*(?:null)?(?=\r?$)(?!\r?\n[ \t]*\S)/gm, 'tags: []');
    // A bare tags key may be followed by another top-level property.
    repaired = repaired.replace(/^tags:[ \t]*(?:null)?\r?\n(?=[\w-]+:)/gm, 'tags: []\n');
    return repaired;
  });
}
