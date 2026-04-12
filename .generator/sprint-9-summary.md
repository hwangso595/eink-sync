# Sprint 9: Optional OCR Integration and Advanced Features

## Summary

Sprint 9 implements Epic 4 NICE TO HAVE stories and remaining stretch features:
optional OCR for handwritten notes, EPUB annotation support, bidirectional sync
opt-in, file watcher for automatic extraction, and batch operations. All new
features are backward-compatible -- the pipeline works identically without any
of them enabled.

## Branch

`sprint/9-ocr-advanced-features`

## Commits

1. `feat: add optional OCR integration for handwritten note recognition`
2. `feat: add EPUB annotation support via internal PDF conversion`
3. `feat: add file watcher for automatic extraction on xochitl changes`
4. `feat: add bidirectional sync opt-in with safety gates`
5. `feat: add batch operations for extract-all, re-extract, and clear-rebuild`
6. `feat: integrate Sprint 9 features into plugin settings and commands`
7. `fix: use SSHExecutor.execute() instead of nonexistent exec() method`

## Features Implemented

### 1. Optional OCR for Handwritten Notes

**Python side:**
- `extraction/ocr_engine.py` -- Core OCR engine wrapping pytesseract
  - Supports image files (PNG, JPEG), raw bytes, and SVG (via cairosvg rasterization)
  - Word-level confidence scoring with configurable threshold
  - Batch processing with per-image error isolation
  - `is_ocr_available()` and `get_ocr_status()` for dependency checking
- `extraction/run_ocr.py` -- CLI entry point for TypeScript bridge
  - Modes: status, file, svg, batch
  - JSON output on stdout, errors on stderr

**TypeScript side:**
- `src/pipeline/ocr-bridge.ts` -- Subprocess bridge to Python OCR
  - `checkOcrStatus()` -- verify Tesseract/pytesseract availability
  - `ocrImageFile()` / `ocrSvgFile()` / `ocrBatch()` -- OCR operations
  - `formatOcrCollapsible()` -- render OCR text as callout block
  - `formatOcrAltText()` -- sanitize OCR text for image alt attributes

**Settings:**
- `ocrEnabled` (default: false) -- master toggle
- `ocrLanguage` (default: "eng") -- Tesseract language code
- `ocrDisplayMode` -- "collapsible" section or "alt-text" on images
- `ocrDisabledNotebooks` -- per-notebook opt-out by UUID

**Dependencies:** pytesseract, Pillow, Tesseract binary (all optional, documented in requirements.txt as comments).

### 2. EPUB Annotation Support

- `extraction/epub_support.py` -- EPUB detection and metadata
  - `is_epub_document()` -- detect from .content fileType
  - `has_converted_pdf()` -- check for internal PDF
  - `get_epub_metadata()` -- annotate extraction results with EPUB origin
  - `discover_epub_documents()` -- filtered discovery
- Updated `extraction/extract.py` with `--include-epub` flag
- Updated `src/pipeline/document-discovery.ts` to include EPUB documents
- Setting: `includeEpub` (default: true)

### 3. File Watcher for Automatic Extraction

- `src/pipeline/file-watcher.ts` -- `XochitlFileWatcher` class
  - Monitors xochitl directory using Node.js `fs.watch` (recursive)
  - Debounces changes (default 10s) to let Syncthing settle
  - Filters to relevant extensions (.rm, .metadata, .content)
  - Event-based API: change-detected, extraction-due, error, started, stopped
  - Integrated into plugin lifecycle (start on load, stop on unload)

**Settings:**
- `autoExtractEnabled` (default: false)
- `autoExtractDebounceSeconds` (default: 10)

### 4. Bidirectional Sync Opt-In

- `src/sync/bidirectional-sync.ts`
  - Explicit warning text explaining risks
  - Config validation: cannot enable without acknowledging warning
  - `restartXochitl()` -- restart xochitl via systemctl after file push
  - `isXochitlRunning()` -- check xochitl status
  - `enableBidirectionalFolder()` / `disableBidirectionalFolder()` -- toggle Syncthing folder type via REST API
  - Confirmation modal in plugin settings before enabling

**Settings:**
- `bidirectionalSync.enabled` (default: false)
- `bidirectionalSync.warningAcknowledged` (default: false)
- `bidirectionalSync.acknowledgedAt` (default: null)

### 5. Batch Operations

- `src/pipeline/batch-operations.ts`
  - `extractAll()` -- full extraction ignoring timestamps
  - `reExtractWithTemplate()` -- regenerate all notes with current template
  - `extractSelected()` -- extract specific UUIDs with partial success
  - `clearAndRebuild()` -- remove output .md files, then re-extract
  - All operations report `BatchOperationResult` with timing and error details
  - New commands and buttons in settings tab

## Settings Tab Updates

Added three new sections to the settings tab:
1. **OCR (Optional)** -- toggle, language, display mode, availability check
2. **Automatic Extraction** -- file watcher toggle, debounce slider, EPUB toggle
3. **Advanced > Bidirectional Sync** -- toggle with confirmation modal

Added to Actions section:
- Extract All Documents button
- Re-extract with Current Template button (warning style)

## Test Results

- **TypeScript:** 393 tests pass across 25 suites (including 36 new Sprint 9 tests)
- **Python:** 23 pass, 6 skipped (OCR deps not installed -- expected)
- Zero regressions in existing tests

## Files Changed

### New Files (Python)
- `extraction/ocr_engine.py` (263 lines)
- `extraction/run_ocr.py` (123 lines)
- `extraction/test_ocr_engine.py` (161 lines)
- `extraction/epub_support.py` (103 lines)
- `extraction/test_epub_support.py` (130 lines)

### New Files (TypeScript)
- `src/pipeline/ocr-bridge.ts` (255 lines)
- `src/pipeline/ocr-bridge.test.ts` (67 lines)
- `src/pipeline/file-watcher.ts` (201 lines)
- `src/pipeline/file-watcher.test.ts` (180 lines)
- `src/pipeline/batch-operations.ts` (273 lines)
- `src/pipeline/batch-operations.test.ts` (98 lines)
- `src/sync/bidirectional-sync.ts` (233 lines)
- `src/sync/bidirectional-sync.test.ts` (60 lines)

### Modified Files
- `extraction/extract.py` -- EPUB support, --include-epub flag
- `extraction/requirements.txt` -- documented optional OCR deps
- `src/pipeline/document-discovery.ts` -- EPUB document discovery
- `src/pipeline/index.ts` -- export new modules
- `src/sync/index.ts` -- export bidirectional sync
- `src/plugin/settings.ts` -- new settings fields
- `src/plugin/settings-tab.ts` -- new UI sections
- `src/plugin/plugin.ts` -- file watcher, OCR, batch, bidirectional integration

## Sprint Self-Evaluation

### Requirements

- Optional OCR for handwritten notes: PASS -- local Tesseract via pytesseract, configurable per notebook, collapsible or alt-text display
- EPUB annotation support: PASS -- detected from .content metadata, same extraction pipeline as PDFs
- Bidirectional sync opt-in: PASS -- gated behind warning acknowledgement, xochitl restart handling
- File watcher for automatic extraction: PASS -- debounced, event-based, integrated with plugin lifecycle
- Batch operations: PASS -- extract all, re-extract, clear-and-rebuild, per-UUID extraction

### Spec Compliance

- OCR text as alt-text or collapsible section: PASS
- User can enable/disable per notebook: PASS (ocrDisabledNotebooks array)
- Local-only (no cloud OCR): PASS
- EPUB from converted PDF: PASS
- xochitl restart for bidirectional: PASS
- Explicit setting with warning: PASS (modal confirmation)
- Debounce file watcher: PASS (configurable, default 10s)
- Batch extract all: PASS
- Re-extract after template changes: PASS

### Known Limitations

1. OCR accuracy depends on Tesseract's handwriting recognition capability, which varies by language model. Handwritten text recognition is lower accuracy than printed text.
2. SVG-to-OCR requires cairosvg as an additional optional dependency for rasterization.
3. The file watcher uses Node.js `fs.watch` which has known platform-specific quirks (e.g., macOS reports multiple events per change). The debounce mechanism mitigates this.
4. Bidirectional sync Syncthing API calls require the API key, which is only available after initial Syncthing setup.

### Confidence Level: High
### Ready for QA: Yes
