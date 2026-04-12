# Product Spec: Safe Folder Migration, Multi-Source Sync, and Vault Isolation

## Vision Statement

The reMarkable-Obsidian Bridge becomes a trustworthy, multi-device knowledge hub where changing a setting never silently loses data, multiple tablets feed into one vault without confusion, and nested vaults coexist without stepping on each other.

## Problem Statement

Three interrelated data-integrity problems have surfaced through real user testing, all stemming from the same root cause: the plugin treats its filesystem state as disposable when it is actually the user's source of truth.

**Problem 1 -- Folder path changes are destructive by omission.** When a user changes `syncFolder`, `highlightsFolder`, or `archiveFolder` in settings, nothing happens to existing files. The old files become orphans. Worse, `lastExtractionTimestamp` is not reset, so incremental extraction silently skips every document in the new folder. The user gets no warning and no migration path.

**Problem 2 -- Single sync source is a hard ceiling.** The plugin assumes one tablet, one sync folder, one extraction timestamp. Users with a household reMarkable (e.g., a shared rM2 and a personal rM1) or users who upgrade tablets have no way to extract from both. Switching the sync folder corrupts the incremental timestamp, and highlight notes from different sources are indistinguishable.

**Problem 3 -- Nested vaults can collide silently.** Obsidian allows a vault inside another vault's directory tree. If both have the plugin enabled and their configured folders overlap on disk, both instances may read/write the same files. File watchers fire twice, extractions race, and data can be corrupted. There is no detection, no locking, and no warning.

All three problems share a theme: the plugin makes irreversible filesystem changes (or fails to make necessary ones) without informing the user. For a privacy-first, local-only user on a reMarkable 1 with 512MB RAM, data loss from silent failures is the worst possible outcome.

## User Personas

**Alex -- The Careful Upgrader.** Has a reMarkable 1, is considering upgrading to rM2. Wants to keep the rM1's highlight archive intact while setting up a new sync folder for the rM2. Terrified of losing years of annotations. Changes settings rarely and reads every warning.

**Jordan -- The Power User.** Runs Obsidian with multiple vaults (a research vault and a personal vault). Has the plugin in both. The personal vault is a subfolder of the research vault. Uses Syncthing aggressively and expects tools to handle edge cases.

**Sam -- The Tinkerer.** Reorganizes their Obsidian vault quarterly. Moves folders around, renames things, and expects plugins to keep up. Will change the highlights folder path when they decide "reMarkable/Highlights" should be "Reading/Annotations" instead.

**Casey -- The Household Sharer.** Two people, two reMarkable tablets, one shared Obsidian vault on a NAS. Each person wants their highlights extracted separately but searchable together.

## Feature Areas

### Area 1: Safe Folder Migration

When the user changes any folder path in settings, the plugin should detect what exists at the old path, offer to move or copy it, and reset relevant state so extraction works correctly against the new location.

Key capabilities:
- Detect existing files at the old folder path before committing the change
- Present a confirmation dialog explaining what will happen (move files, leave in place, or cancel)
- If the user chooses to migrate, move files from old path to new path within the vault
- Reset `lastExtractionTimestamp` when `syncFolder` changes (regardless of migration choice)
- Restart the file watcher pointed at the new sync folder
- Update Syncthing folder config (already partially implemented for syncFolder)
- Log every file operation to the console for debugging

Connections: This area is a prerequisite for Area 2 (multi-source), because multi-source effectively changes the "active" sync folder. It also interacts with Area 3 (vault isolation) because folder path validation must account for other vault instances.

### Area 2: Multi-Source Sync

Replace the single-source model with a named "sync source" concept. Each source has its own sync folder, extraction timestamp, and optional label. The default experience remains single-source (zero configuration change for existing users), but power users can add additional sources.

Key capabilities:
- A "sync source" data structure that bundles: a user-visible label, a sync folder path, a Syncthing folder ID, a `lastExtractionTimestamp`, and optional metadata (tablet model, connection info)
- Existing single-source settings migrate automatically to a single default source on upgrade (backward compatible -- no user action required)
- Add/remove sync sources from settings
- Each source extracts independently with its own incremental timestamp
- Highlight notes include a `source` frontmatter field indicating which sync source produced them
- The library view shows a source filter/grouping (e.g., a dropdown or tabs)
- The file watcher monitors all active sync source folders
- "Extract all" iterates over every source; "Extract" button in settings works per-source
- Status bar shows aggregate state across all sources

Connections: This area depends on Area 1 (folder migration) for per-source folder changes. It interacts with Area 3 (vault isolation) because multiple sources increase the surface area for path collisions.

### Area 3: Vault Isolation and Collision Detection

Detect when the plugin's configured folders overlap with another vault instance (or with themselves in unusual configurations) and warn the user. This is a defensive feature -- it should never block the user, only inform.

Key capabilities:
- On plugin load, write a lightweight "claim file" (e.g., `.remarkable-bridge-instance` ) inside each managed folder containing the vault path and a timestamp
- On plugin load, check each managed folder for an existing claim file from a different vault path
- If a collision is detected, show a persistent warning banner in settings and a one-time Notice on load
- The claim file is removed (best-effort) on plugin unload
- Validate that sync, highlights, and archive folders do not overlap with each other (partially implemented -- extend the existing duplicate detection)
- Validate that no configured folder is an ancestor or descendant of another configured folder from the same instance
- Warn if a configured folder path resolves to a location outside the vault root (this can happen with absolute paths or symlinks)

Connections: This area validates the filesystem assumptions that Areas 1 and 2 rely on. It should run its checks after any folder path change (Area 1) and after adding a new sync source (Area 2).

### Area 4: Extraction State Integrity

Harden the extraction timestamp and incremental logic so that state mismatches are detected and surfaced rather than silently causing missed documents.

Key capabilities:
- When `syncFolder` changes, automatically reset the extraction timestamp for that source and inform the user ("Extraction will re-process all documents in the new folder on next run")
- Store a hash or fingerprint of the sync folder path alongside the timestamp, so that if the path changes outside the settings UI (e.g., manual data.json edit), the mismatch is caught
- On extraction, if the sync folder is empty or missing, show a clear error instead of reporting "no new highlights"
- Add a "Reset extraction state" button per source in advanced settings (already partially addressed by "Extract all highlights" command, but make it more discoverable)
- After migration (Area 1), offer to run a full extraction against the new folder immediately

Connections: This area is the safety net for Areas 1 and 2. Every folder path change or source switch must flow through extraction state validation.

## User Stories

### Epic 1: Safe Folder Migration (Alex, Sam)

**As Alex, I want to be warned before changing the highlights folder so that I do not accidentally orphan months of extracted notes.**
- When I change `highlightsFolder` in settings, a confirmation dialog appears before the change is saved
- The dialog tells me how many files exist at the old path
- I can choose "Move files to new location", "Keep files in old location", or "Cancel"
- If I choose "Move", all files are relocated and a Notice confirms the count
- If I choose "Keep", the change is saved but a Notice reminds me that old files remain at the previous path
- Priority: Must Have

**As Sam, I want the extraction timestamp to reset when I point the plugin at a new sync folder so that documents in the new folder are not skipped.**
- When `syncFolder` changes, `lastExtractionTimestamp` for that source is set to null
- A Notice informs me: "Extraction state reset. All documents in the new folder will be processed on next run."
- The file watcher restarts pointed at the new path
- Priority: Must Have

**As Alex, I want the plugin to create the new folder if it does not exist so that I do not have to manually create it first.**
- After confirming a folder path change, the plugin calls `ensureFolders` for the new path
- If folder creation fails, the settings change is rolled back and an error Notice is shown
- Priority: Must Have

**As Sam, I want a dry-run preview of what migration will do so that I can verify before committing.**
- The confirmation dialog lists the count and total size of files to be moved
- For the sync folder, it additionally notes that the Syncthing config will be updated
- Priority: Should Have

**As Alex, I want the migration to be atomic (all-or-nothing) so that a partial failure does not leave files in both locations.**
- If any file move fails, the entire migration is rolled back and an error is shown
- The old settings value is restored if rollback occurs
- Priority: Should Have

**As Sam, I want to undo a folder migration within a reasonable window so that I can recover from mistakes.**
- After a successful migration, a Notice with an "Undo" action button appears for 30 seconds
- Clicking "Undo" moves files back and restores the previous folder path
- Priority: Nice to Have

### Epic 2: Multi-Source Sync (Casey, Jordan)

**As Casey, I want to add a second sync source for my partner's reMarkable so that both tablets' highlights land in our shared vault.**
- In settings, a "Sync Sources" section lists all configured sources
- An "Add source" button opens a form for label, sync folder path, and Syncthing folder ID
- Each source shows its last extraction time and document count
- Priority: Must Have

**As Casey, I want each source's highlights to be tagged with the source name so that I can tell whose annotations are whose.**
- Highlight notes include `source: "Casey's rM1"` (or whatever the label is) in YAML frontmatter
- The default source for migrated single-source users is labeled "Default"
- Priority: Must Have

**As Jordan, I want to remove a sync source without deleting its highlight notes so that I can clean up after decommissioning a tablet.**
- Removing a source deletes only the source configuration, not any files on disk
- A confirmation dialog warns that the sync folder and highlight notes will remain
- Priority: Must Have

**As Casey, I want the library view to filter by source so that I can see just my documents or just my partner's.**
- The library view header has a source selector (dropdown showing "All", "Casey's rM1", "Partner's rM2")
- Selecting a source filters the document list to only that source's sync folder
- Priority: Should Have

**As Jordan, I want extraction to run per-source with independent timestamps so that extracting one source does not affect the other.**
- Each sync source has its own `lastExtractionTimestamp`
- "Extract new highlights" iterates sources sequentially, using each source's timestamp
- "Extract all highlights" resets all source timestamps
- Priority: Must Have

**As Casey, I want highlight notes from different sources to go into source-specific subfolders so that they are organized on disk.**
- Each source can optionally specify a highlights subfolder (default: source label as subfolder name)
- If not specified, all sources share the main `highlightsFolder` (backward compatible)
- Priority: Should Have

**As an existing user upgrading the plugin, I want my current settings to migrate seamlessly to the multi-source model so that nothing breaks.**
- On first load after upgrade, if settings contain the old single-source fields, they are wrapped into a single source entry labeled "Default"
- `lastExtractionTimestamp` is preserved on the default source
- The old top-level fields are removed from data.json after migration
- No user action required
- Priority: Must Have

### Epic 3: Vault Isolation and Collision Detection (Jordan)

**As Jordan, I want to be warned on plugin load if another vault instance is using the same sync folder so that I do not get corrupted extractions.**
- On load, the plugin checks for a `.remarkable-bridge-instance` file in each managed folder
- If the file exists and contains a different vault path, a Notice warns: "Another Obsidian vault ([path]) is also using this folder. This may cause conflicts."
- The warning appears in the settings tab as a persistent banner
- Priority: Must Have

**As Jordan, I want the plugin to detect when my subvault's folders are inside the parent vault's managed tree so that I can reconfigure before damage occurs.**
- On load, the plugin resolves all folder paths to absolute paths and checks for ancestor/descendant relationships with known claim files
- If overlap is detected, the warning specifies which vault and which folder overlap
- Priority: Must Have

**As Jordan, I want the collision warning to be dismissible so that I can acknowledge known-safe configurations.**
- The warning banner in settings has a "Dismiss" button that persists the dismissal in data.json keyed to the specific collision (vault path + folder path pair)
- If the collision changes (different vault), the dismissal is reset
- Priority: Should Have

**As Jordan, I want the claim file to be cleaned up when the plugin unloads so that stale claims do not cause false warnings.**
- On plugin unload, the plugin attempts to delete its claim files
- If deletion fails (e.g., permissions), it is silently ignored
- Claim files older than 7 days without a refresh are treated as stale and ignored by other instances
- Priority: Should Have

**As any user, I want to be warned if a configured folder resolves to a path outside my vault so that I do not accidentally write to unexpected locations.**
- After resolving a folder path, the plugin checks if it starts with the vault base path
- If not, a warning Notice is shown: "The folder [path] is outside your vault. This is unusual and may cause issues with Obsidian indexing."
- The setting is still saved (warn, do not block)
- Priority: Nice to Have

### Epic 4: Extraction State Integrity (Alex, Sam)

**As Alex, I want the plugin to detect when the sync folder is empty and tell me clearly so that I do not think extraction succeeded with zero results.**
- If the sync folder contains zero `.metadata` files, extraction shows: "No documents found in [folder]. Is Syncthing running and synced?"
- This replaces the current "No new highlights found" message in the empty-folder case
- Priority: Must Have

**As Sam, I want a per-source "Reset extraction state" button so that I can force a full re-extraction without re-extracting other sources.**
- Each source in settings has a "Reset" button that nullifies its `lastExtractionTimestamp`
- Clicking it shows a confirmation: "Next extraction will re-process all documents in [source label]."
- Priority: Should Have

**As Alex, I want the extraction timestamp to be validated against the sync folder path so that a data.json edit does not silently break incremental extraction.**
- The timestamp is stored alongside a hash of the sync folder path
- If the hash does not match on extraction, the timestamp is treated as invalid and a full extraction runs with a Notice explaining why
- Priority: Should Have

## Key User Flows

### Flow 1: Changing the Highlights Folder (Sam)

Sam decides to reorganize their vault and wants highlights at "Reading/Annotations" instead of "reMarkable/Highlights". They open settings and change the path. A dialog appears: "You have 47 highlight notes in reMarkable/Highlights. What would you like to do?" with three buttons: Move to new location, Keep in old location, Cancel. Sam picks "Move." The plugin creates "Reading/Annotations" if needed, moves all 47 files, updates the settings, and shows "Moved 47 files to Reading/Annotations." The drawings subfolder is also moved. Sam opens the library view and clicks a document -- the "Open note" button correctly opens the note at its new location.

### Flow 2: Adding a Second Tablet (Casey)

Casey's partner gets a reMarkable 2. Casey opens settings, scrolls to Sync Sources, and clicks "Add source." They enter the label "Partner's rM2", set the sync folder to "reMarkable/Partner-Sync", and enter the Syncthing folder ID from their partner's Syncthing setup. The plugin creates the folder and starts watching it. When the partner syncs for the first time, the file watcher triggers extraction. The resulting highlight notes appear in "reMarkable/Highlights/Partner's rM2/" with `source: "Partner's rM2"` in frontmatter. Casey opens the library view, picks "Partner's rM2" from the source dropdown, and sees only their partner's documents.

### Flow 3: Detecting a Nested Vault Collision (Jordan)

Jordan has a research vault at `~/Research` and a personal vault at `~/Research/Personal`. Both have the reMarkable Bridge plugin. The personal vault's sync folder is "reMarkable/Sync", which resolves to `~/Research/Personal/reMarkable/Sync` -- safely outside the research vault's `~/Research/reMarkable/Sync`. No collision. But then Jordan changes the personal vault's sync folder to `../../reMarkable/Sync`, which resolves to `~/Research/reMarkable/Sync` -- the same folder the research vault uses. On save, the plugin checks the claim file, finds it belongs to the research vault, and shows: "Warning: The vault 'Research' at ~/Research is also using this sync folder. Running both plugins on the same folder may cause duplicate extractions or data corruption." Jordan sees this and changes the path back.

### Flow 4: Upgrading from Single-Source to Multi-Source (Alex)

Alex has been using the plugin for a year with a single reMarkable 1. They update to the new version. On load, the plugin detects old-format settings (top-level `syncFolder` + `lastExtractionTimestamp`) and silently migrates them into a source entry labeled "Default" with all existing values preserved. Alex opens settings and sees "Sync Sources: Default (reMarkable/Sync) -- last extracted 2 hours ago." Everything works exactly as before. Later, when Alex gets an rM2, they add a second source. The "Default" source stays untouched.

## Success Metrics

1. **Zero data loss incidents from folder changes.** No user reports orphaned files or missed extractions after changing a folder path. Measured by: absence of related bug reports in the first 30 days after release.

2. **Migration completion rate above 95%.** When the migration dialog appears, at least 95% of users complete it (move or keep) rather than canceling. Measured by: debug logging opt-in telemetry (local only, never transmitted).

3. **Multi-source adoption.** At least 10% of active users configure a second sync source within 90 days. Measured by: the count of sources in settings when users voluntarily share configs for support.

4. **Collision detection true-positive rate.** Every collision warning corresponds to a real overlap. Zero false positives. Measured by: absence of "false warning" bug reports.

5. **Upgrade seamlessness.** Zero users need to reconfigure settings after upgrading. Measured by: no "my settings disappeared" or "extraction stopped working after update" reports.

## Phased Rollout

### Phase 1 -- MVP: Safe Folder Migration and Extraction State Integrity
**Sprint 1 [Code Review]**
- Implement the folder change confirmation dialog (migration prompt)
- Wire the dialog into all three folder path change handlers in `settings-tab.ts`
- Implement file move logic within the vault (using Obsidian's vault API, not raw fs)
- Reset `lastExtractionTimestamp` when `syncFolder` changes
- Restart file watcher on sync folder change
- Ensure `ensureFolders` is called for the new path before migration

**Sprint 2 [Both]**
- Implement empty-folder detection in extraction pipeline (distinguish "no new highlights" from "folder is empty/missing")
- Add path-hash validation for extraction timestamps
- Add "Reset extraction state" button to advanced settings
- Settings tab UI for folder migration status and warnings

**Quality gate:** Code-design-evaluator must pass (70/120 minimum). Acceptance criteria: changing any folder path triggers a dialog, timestamp resets on sync folder change, empty folder produces a distinct error message, no regressions in extraction.

### Phase 2 -- Growth: Multi-Source Sync
**Sprint 3 [Code Review]**
- Define the `SyncSource` data structure (label, syncFolder, syncthingFolderId, lastExtractionTimestamp, pathHash)
- Implement settings migration: single-source fields to multi-source array, backward compatible
- Update `loadSettings` / `saveSettings` to handle the sources array
- Update `PipelineConfig` to accept source context
- Update extraction pipeline to iterate over sources with per-source timestamps

**Sprint 4 [Both]**
- Settings tab UI for managing sync sources (list, add, remove, edit)
- Per-source "Extract" and "Reset" buttons
- Highlight notes include `source` field in frontmatter
- File watcher monitors all source folders
- Design direction for the sources UI: functional and compact, inspired by Obsidian's own "Sync" and "Publish" settings panels. Use standard Obsidian setting components. No custom color coding -- rely on labels and hierarchy. The sources list should feel like a native Obsidian setting, not a dashboard widget.

**Sprint 5 [UI Review]**
- Library view source filter dropdown
- Status bar aggregate across sources
- Source-specific highlights subfolder support (optional per-source override)

**Quality gate:** Both evaluators must pass. Design evaluator checks that the sources UI feels native to Obsidian. Code evaluator checks that the source abstraction is clean, settings migration is lossless, and per-source extraction is independent.

### Phase 3 -- Scale: Vault Isolation and Defensive Hardening
**Sprint 6 [Code Review]**
- Implement claim file write/read/cleanup lifecycle
- Collision detection logic: check claim files on load and on folder path change
- Stale claim detection (7-day expiry)
- Outside-vault-root detection for resolved paths

**Sprint 7 [Both]**
- Warning banner in settings tab for active collisions
- Dismissible warnings with persistence in data.json
- One-time Notice on load for new collisions
- Integration with Area 1 (run collision check after migration) and Area 2 (run collision check after adding source)
- Design direction for warnings: use Obsidian's `--text-error` and `--text-warning` CSS variables. Warnings should look like Obsidian's own validation messages (e.g., the "community plugin" warning). No alert icons or colored backgrounds beyond what Obsidian natively uses.

**Quality gate:** Both evaluators must pass. Specific checks: claim files are cleaned up on unload, stale detection works, warnings do not block user actions, no false positives in path overlap detection.

## Risks and Open Questions

**Risk: Obsidian vault API limitations for file moves.** The vault API may not support moving files between arbitrary paths efficiently, especially for large numbers of files. The implementation may need to fall back to Node.js `fs` operations for cross-directory moves, which would bypass Obsidian's file indexing. Validate early in Sprint 1.

**Risk: Claim file conflicts with Syncthing.** If the claim file is written inside the sync folder, Syncthing will sync it to the tablet, which is wasteful. The claim file should either be placed in Obsidian's plugin data directory instead of the managed folders, or added to `.stignore`. Open question: which approach is less fragile?

**Risk: Multi-source settings migration edge cases.** Users who have manually edited `data.json` may have unexpected field combinations. The migration logic must handle missing fields, extra fields, and malformed data gracefully without throwing.

**Risk: File watcher scalability with multiple sources.** Each source adds a file watcher. On systems with many sources or large sync folders, this could hit OS limits (especially on Windows with `ReadDirectoryChangesW` limits). Consider whether a single watcher with path routing is more appropriate than per-source watchers.

**Open question: Should multi-source support per-source Syncthing connections (different API keys, different Syncthing instances)?** The current design assumes one Syncthing instance with multiple folder IDs. A household with two separate computers each running Syncthing would need per-source Syncthing config. Defer to Phase 2 feedback.

**Open question: Should the migration dialog support "Copy" in addition to "Move"?** Copy is safer but doubles disk usage. For users on SSDs with limited space, this may not be desirable. Start with Move and Keep only; add Copy if users request it.

**Open question: How should the library view handle documents that exist in multiple sources (same PDF sent to two tablets)?** Deduplicate by content hash? Show duplicates with source labels? Defer to Phase 2 user feedback.
