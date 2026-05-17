---
title: "{{title}}"
author: "{{author}}"
source_pdf: "[[{{source_pdf}}]]"
source_type: pdf
date_highlighted: {{date}}
highlight_count: {{highlight_count}}
remarkable_uuid: {{uuid}}
tags:
{{tags_yaml}}
---

# {{title}}

{{#if author}}
**Author:** {{author}}
{{/if}}

**Source:** [[{{source_pdf}}]]

%%--- eink-sync highlights start ---%%
## Highlights

{{#each highlights}}
> {{text}}
> -- {{pdf_link}}

{{/each}}
%%--- eink-sync highlights end ---%%

## Notes

_Add your own notes about this document here. This section is preserved during highlight updates._
