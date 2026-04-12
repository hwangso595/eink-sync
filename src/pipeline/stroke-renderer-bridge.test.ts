/**
 * Tests for stroke-renderer-bridge.ts.
 *
 * These tests cover the pure functions and type contracts.
 * Spawn-based integration tests require Python and are run separately.
 */

import { resolveRenderScriptPath } from './stroke-renderer-bridge';
import type { StrokeRenderOutput, RenderedPage } from './stroke-renderer-bridge';
import * as path from 'path';

describe('resolveRenderScriptPath', () => {
  it('returns path to extraction/render_strokes.py relative to plugin dir', () => {
    const result = resolveRenderScriptPath('/home/user/.obsidian/plugins/rm-bridge');
    expect(result).toBe(
      path.join('/home/user/.obsidian/plugins/rm-bridge', 'extraction', 'render_strokes.py'),
    );
  });

  it('handles Windows-style paths', () => {
    const result = resolveRenderScriptPath('C:\\Users\\test\\vault\\.obsidian\\plugins\\rm');
    expect(result).toContain('extraction');
    expect(result).toContain('render_strokes.py');
  });
});

describe('StrokeRenderOutput type contract', () => {
  it('parses a successful render output', () => {
    const json = `{
      "success": true,
      "pages": [
        {
          "page_index": 0,
          "page_uuid": "abc-123",
          "svg_path": "/tmp/output/page-1.svg",
          "has_strokes": true,
          "stroke_count": 42
        },
        {
          "page_index": 1,
          "page_uuid": "def-456",
          "svg_path": null,
          "has_strokes": false,
          "stroke_count": 0
        }
      ],
      "doc_type": "notebook",
      "visible_name": "My Notebook",
      "errors": []
    }`;

    const raw = JSON.parse(json);
    expect(raw.success).toBe(true);
    expect(raw.pages).toHaveLength(2);
    expect(raw.pages[0].has_strokes).toBe(true);
    expect(raw.pages[0].stroke_count).toBe(42);
    expect(raw.pages[1].svg_path).toBeNull();
    expect(raw.doc_type).toBe('notebook');
  });

  it('parses an error output', () => {
    const json = `{
      "success": false,
      "pages": [],
      "doc_type": "unknown",
      "visible_name": "",
      "errors": ["Content file not found"]
    }`;

    const raw = JSON.parse(json);
    expect(raw.success).toBe(false);
    expect(raw.errors).toHaveLength(1);
  });

  it('parses page-level errors', () => {
    const json = `{
      "success": true,
      "pages": [
        {
          "page_index": 0,
          "page_uuid": "abc",
          "svg_path": null,
          "has_strokes": false,
          "stroke_count": 0,
          "error": "Unsupported .rm format"
        }
      ],
      "doc_type": "notebook",
      "visible_name": "Test",
      "errors": ["Page 1 (abc): Unsupported .rm format"]
    }`;

    const raw = JSON.parse(json);
    expect(raw.pages[0].error).toBe('Unsupported .rm format');
  });
});

describe('RenderedPage type shape', () => {
  it('has the expected fields after transformation', () => {
    const page: RenderedPage = {
      pageIndex: 0,
      pageUuid: 'test-uuid',
      svgPath: '/output/page-1.svg',
      hasStrokes: true,
      strokeCount: 15,
    };

    expect(page.pageIndex).toBe(0);
    expect(page.pageUuid).toBe('test-uuid');
    expect(page.hasStrokes).toBe(true);
    expect(page.strokeCount).toBe(15);
  });
});
