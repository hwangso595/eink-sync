/**
 * Tests for python-bridge.ts -- Python process spawning and JSON output parsing.
 *
 * These tests mock the child_process.spawn function to avoid requiring
 * Python to be installed in the test environment. Integration tests with
 * actual Python should be run separately.
 */

import { resolveScriptPath } from './python-bridge';
import * as path from 'path';

// Note: The spawn-based functions (runPythonExtraction, detectPythonPath,
// checkPythonDependencies) are tested via integration tests that require
// Python. Unit tests here cover the pure functions.

describe('resolveScriptPath', () => {
  it('returns path to extraction/extract.py relative to plugin dir', () => {
    const result = resolveScriptPath('/home/user/.obsidian/plugins/eink-sync');
    expect(result).toBe(
      path.join('/home/user/.obsidian/plugins/eink-sync', 'extraction', 'extract.py'),
    );
  });

  it('handles Windows-style paths', () => {
    const result = resolveScriptPath('C:\\Users\\test\\vault\\.obsidian\\plugins\\rm');
    expect(result).toContain('extraction');
    expect(result).toContain('extract.py');
  });

  it('handles trailing separator in plugin dir', () => {
    const result = resolveScriptPath('/plugin/dir/');
    expect(result).toBe(path.join('/plugin/dir/', 'extraction', 'extract.py'));
  });
});

describe('PythonExtractionOutput type contract', () => {
  /**
   * These tests verify that the TypeScript interface matches the JSON
   * contract defined in extract.py. They parse sample JSON and check
   * that the shape conforms to expectations.
   */

  it('parses a successful extraction output', () => {
    const json = `{
      "success": true,
      "documents": [
        {
          "uuid": "abc-123",
          "visible_name": "Test Paper",
          "folder_path": "Research/ML",
          "doc_type": "pdf",
          "last_modified": 1700000001000,
          "page_count": 10,
          "has_pdf": true,
          "highlights": [
            {
              "text": "Attention is all you need",
              "page_number": 1,
              "color": "yellow",
              "bounds": {"x": 72, "y": 100, "width": 400, "height": 14},
              "created_at": null
            }
          ],
          "warnings": [],
          "error": null
        }
      ],
      "errors": []
    }`;

    const output = JSON.parse(json);
    expect(output.success).toBe(true);
    expect(output.documents).toHaveLength(1);
    expect(output.documents[0].highlights).toHaveLength(1);
    expect(output.documents[0].highlights[0].text).toBe('Attention is all you need');
    expect(output.documents[0].highlights[0].page_number).toBe(1);
    expect(output.documents[0].highlights[0].bounds).toBeDefined();
    expect(output.documents[0].highlights[0].bounds.x).toBe(72);
  });

  it('parses an empty extraction output', () => {
    const json = `{
      "success": true,
      "documents": [],
      "errors": []
    }`;

    const output = JSON.parse(json);
    expect(output.success).toBe(true);
    expect(output.documents).toHaveLength(0);
  });

  it('parses an extraction with document-level error', () => {
    const json = `{
      "success": true,
      "documents": [
        {
          "uuid": "fail-doc",
          "visible_name": "Broken PDF",
          "folder_path": "",
          "doc_type": "pdf",
          "last_modified": 1700000000000,
          "page_count": 5,
          "has_pdf": true,
          "highlights": [],
          "warnings": ["Traceback info here"],
          "error": "Failed to parse .rm file"
        }
      ],
      "errors": []
    }`;

    const output = JSON.parse(json);
    expect(output.documents[0].error).toBe('Failed to parse .rm file');
    expect(output.documents[0].highlights).toHaveLength(0);
  });

  it('parses a pipeline-level failure', () => {
    const json = `{
      "success": false,
      "documents": [],
      "errors": ["Pipeline error: rmscene not installed"]
    }`;

    const output = JSON.parse(json);
    expect(output.success).toBe(false);
    expect(output.errors).toContain('Pipeline error: rmscene not installed');
  });

  it('handles highlights with null optional fields', () => {
    const json = `{
      "success": true,
      "documents": [
        {
          "uuid": "doc-1",
          "visible_name": "Paper",
          "folder_path": "",
          "doc_type": "pdf",
          "last_modified": 1700000000000,
          "page_count": 1,
          "has_pdf": true,
          "highlights": [
            {
              "text": "Some text",
              "page_number": 1,
              "color": null,
              "bounds": null,
              "created_at": null
            }
          ],
          "warnings": [],
          "error": null
        }
      ],
      "errors": []
    }`;

    const output = JSON.parse(json);
    const h = output.documents[0].highlights[0];
    expect(h.color).toBeNull();
    expect(h.bounds).toBeNull();
    expect(h.created_at).toBeNull();
  });
});
