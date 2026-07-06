# Codebase Cleanup Plan

This plan is based on the full audit of bugs, thin wrappers, dead layers, and test weight.
Goal: make the happy paths and sad paths honest, then remove code that does not serve the product.

## Principles

- Fix correctness before deleting large areas.
- Keep tests that protect real tablet data, extraction formats, and destructive operations.
- Delete tests with dead modules instead of keeping coverage for unused features.
- Prefer one clear path over parallel abstractions.
- Make failures visible. No "success" result should contain ignored fatal errors.

## Phase 1: Correctness First

### 1. Fix sync result semantics

Problem:
- Manual sync, auto-sync, and Syncthing API calls can report success after failure.
- `SyncResult` has no `success` field.
- `SftpProvider` drops `SftpSyncResult.success`.
- Syncthing rescan does not check HTTP status.

Plan:
- Add `success: boolean` to `SyncResult`.
- Preserve SFTP engine failure state in `SftpProvider`.
- Check `response.ok` for Syncthing API calls.
- Update library and auto-sync UI to show failure when sync failed.

Tests to add:
- SFTP engine returns `success:false` -> library shows failed sync.
- Syncthing rescan returns 403/404 -> provider returns failure.
- Auto-sync does not mark status idle after failed transfer.

### 2. Fix selected-document extraction

Problem:
- TypeScript filters selected UUIDs, but `PythonHighlightExtractor` still extracts the whole xochitl folder.
- Per-document fallback has the same problem.

Plan:
- Pass explicit UUID filters to the Python bridge.
- Update `extract.py` to honor the UUID list.
- Fail if selected UUIDs are not found instead of silently processing everything.

Tests to add:
- Extract selected document only processes that UUID.
- Missing selected UUID returns a visible failure.

### 3. Fix Python failure handling

Problem:
- Python can emit `success:false`, but TypeScript mostly validates shape and maps documents anyway.
- Fatal Python states can become "No new highlights found."

Plan:
- Treat pipeline-level `success:false` as extraction failure.
- Preserve Python `errors` and `warnings` separately.
- Define which per-document errors are partial success vs full failure.

Tests to add:
- Python `success:false` fails the pipeline.
- Per-document error does not advance the source cursor.

### 4. Fix stale note behavior

Problem:
- If a document now has zero highlights/drawings, the pipeline skips writing.
- Old highlights remain in Obsidian forever.

Plan:
- If an output note already exists, write an empty managed section or mark it stale.
- Only skip creating a brand-new note when there is no extracted content.
- Fix README text that says `overwriteExisting` solves this.

Tests to add:
- Existing note with old highlights becomes empty/updated when tablet highlights are removed.
- New document with zero highlights does not create noise.

### 5. Fix release packaging

Problem:
- Runtime expects `pluginDir/extraction/extract.py`.
- Release uploads only `manifest.json`, `main.js`, and `styles.css`.

Plan:
- Create a runtime asset manifest.
- Include only required Python/runtime files in release.
- Do not ship Python tests or experiments in plugin installs.

Tests/checks to add:
- Release dry-run lists required runtime assets.
- Installed package contains `extraction/extract.py` and required helper modules.

## Phase 2: Sync Mode Honesty

### 1. Decide what SFTP supports

Problem:
- Default mode is SFTP, but some actions assume push sync.
- "Send to reMarkable" writes local files but SFTP is pull-only.
- Library archive/delete/unarchive only moves local files while claiming tablet changes.

Decision needed:
- Either implement real SSH/SFTP upload/delete/restore, or disable these commands in SFTP mode.

Recommended:
- Disable push/archive/delete/unarchive tablet actions in SFTP first.
- Add real SFTP upload/delete later if needed.

Tests to add:
- In SFTP mode, send-to-tablet is hidden or returns a clear unsupported message.
- Archive/delete/unarchive cannot claim tablet-side success in SFTP mode.

### 2. Wire or remove Syncthing setup manager

Problem:
- Wizard installs binaries but does not run full service/config setup.
- `setupSyncPairing()` / `setupSync()` exists but is not wired into the wizard.

Plan:
- Wire the full setup path into the wizard, or delete the unused manager path.
- Verify service/config/API health before marking setup complete.

Tests to add:
- Syncthing wizard runs config creation, `.stfolder`, service deploy, and service start.
- Setup complete requires actual reachable service/API state.

### 3. Fix multi-source behavior

Problem:
- Global SFTP sync computes target sources but uses only the first source.
- Extraction can then scan more sources than were synced.
- Status modal scans only the legacy single folder.

Plan:
- Loop sync per source, or explicitly reject multi-source SFTP until implemented.
- Make status modal use `getSyncSources()`.
- Make source-specific highlight subfolders work for note opening.

Tests to add:
- Multi-source sync processes all configured sources.
- Source-specific highlight note opens from the correct subfolder.
- Status modal reports all sources.

## Phase 3: Delete Dead Layers

Delete only after Phase 1 and Phase 2 decisions are made.

### Strong delete candidates

- `src/sync/rsync-fallback.ts`
- `src/sync/rsync-fallback.test.ts`
- rsync branches in `src/sync/sync-manager.ts`
- rsync-related tests in `src/sync/sync-manager.test.ts`
- `src/sync/bidirectional-sync.ts`
- `src/sync/bidirectional-sync.test.ts`
- `src/pipeline/ocr-bridge.ts`
- `src/pipeline/ocr-bridge.test.ts`
- `extraction/ocr_engine.py`
- `extraction/run_ocr.py`
- `extraction/test_ocr_engine.py`
- `src/pipeline/batch-operations.ts`
- `src/pipeline/batch-operations.test.ts`
- stale `templates/remarkable-highlight.md`, unless generated from the real default template

### Conditional delete candidates

- `src/pipeline/stroke-renderer-bridge.ts`
- `src/pipeline/stroke-renderer-bridge.test.ts`
- `src/pipeline/notebook-renderer.ts`
- `src/pipeline/notebook-renderer.test.ts`

Keep these only if notebook rendering is productized in the current UI.

## Phase 4: Flatten Thin Wrappers

### 1. Reduce export barrels

Problem:
- `src/main.ts` exports a broad public API for an Obsidian plugin.
- This keeps extra code reachable in `main.js`.

Plan:
- Make plugin entry export only the default plugin.
- Move any library API to a separate non-release entry if needed.
- Trim `src/pipeline/index.ts` and `src/sync/index.ts` after dead-code deletion.

### 2. Collapse duplicate rendering logic

Problem:
- `markdown-renderer.ts` and `template-engine.ts` duplicate PDF link formatting, merge behavior, tag rendering, and filename sanitizing.

Plan:
- Keep one rendering path.
- Prefer making default markdown output use the same template engine.
- Move shared filename/link helpers into one small utility module.

### 3. Remove legacy migration scaffolding when safe

Problem:
- Settings and plugin state carry many legacy top-level fields and sync-source mirrors.

Plan:
- Keep only the migration code needed for one supported version window.
- After migration, remove duplicate top-level reads/writes.

## Phase 5: Test Suite Rebalance

The suite is not "mostly useless," but it is overweight in the wrong places.

### Delete with dead modules

Obvious prune bucket:

- rsync tests: about 23 cases, plus sync-manager rsync cases
- bidirectional sync tests: about 9 cases
- OCR TS/Python tests: about 33 cases
- notebook/stroke bridge tests: about 22 cases if not productized
- batch operation tests: about 4 cases

Expected reduction: roughly 90-120 tests, depending on final product decisions.

### Keep

Keep tests that protect real data or destructive behavior:

- highlight extraction formats
- render page behavior
- metadata discovery
- SFTP comparison/download decisions
- archive safety gates
- UUID validation
- vault isolation
- markdown merge behavior after it is fixed

### Add fewer, stronger product-flow tests

Add tests for:

- release package contains runtime Python assets
- selected extraction honors UUID filters
- Python `success:false` fails loudly
- stale notes update when highlights are removed
- SFTP failure remains failure in manual and auto-sync
- SFTP mode does not pretend to push/delete tablet files
- Syncthing wizard runs full setup
- multi-source sync is either supported or explicitly rejected

## Phase 6: Local Artifact Cleanup

Problem:
- Root contains ignored/debug PNGs and temp folders.

Plan:
- Delete local scratch artifacts after confirming none are intentional fixtures.
- Keep permanent fixtures only under `test-data/`.
- Add a short convention to README or contributor docs for renderer-quality artifacts.

Examples to review:

- `_cmp_tmp`
- `_sweep_tmp`
- `test-output`
- root-level debug PNGs
- `.pytest_cache`
- `dist`

## Recommended Order

1. Fix sync result semantics.
2. Fix selected extraction and Python failure handling.
3. Fix stale notes.
4. Fix release packaging.
5. Make SFTP/Syncthing capabilities honest in UI and commands.
6. Delete dead modules and their tests.
7. Flatten barrels/renderers/wrappers.
8. Rebalance tests around real product flows.

## Success Criteria

- No UI path reports success after a failed transfer, API call, or extraction.
- Default SFTP mode only exposes actions it can actually perform.
- Release installs contain all runtime assets and no test-only Python files.
- Selected extraction processes only selected documents.
- Removing highlights on the tablet updates existing Obsidian notes.
- The test suite is smaller but catches the bugs found in this audit.
