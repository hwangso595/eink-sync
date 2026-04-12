# Product Spec: Zero-Dependency SFTP Sync

## Vision Statement

The reMarkable-Obsidian Bridge becomes a one-click setup experience: plug in your tablet's WiFi password, and your highlights flow into Obsidian automatically -- no Syncthing, no rsync, no background services, no external tools.

## Problem Statement

The current sync architecture requires users to install and configure Syncthing on both their computer and their reMarkable tablet. This is the single biggest barrier to adoption:

- Syncthing installation requires Entware on the tablet, which needs internet access on a device that is deliberately offline-first.
- Users must understand Syncthing concepts (device IDs, folder pairing, send/receive modes) that have nothing to do with their actual goal: getting highlights into Obsidian.
- On the rM1, Syncthing consumes 50-100MB of a 512MB RAM budget. A memory watchdog service exists specifically to prevent the tablet from becoming unresponsive.
- The setup wizard is 5 steps. Three of those steps (Install, Pairing, First Sync) exist solely because of Syncthing.

Meanwhile, the plugin already has a mature SSH client (`ReMarkableSSHClient` in `src/ssh/ssh-client.ts`) that connects to the tablet's built-in Dropbear SSH server. The `ssh2` npm library -- already installed -- includes full SFTP support via `client.sftp()`. The tablet's xochitl directory is a known, stable path.

The opportunity: collapse the entire sync layer into a feature that uses what already exists. No new dependencies. No tablet-side installation. No background services on the tablet.

## User Personas

**The Casual Reader** -- Anna, 34, product designer. Reads 2-3 books per month on her rM2. She highlights passages she wants to reference later. She uses Obsidian for notes but is not technical. She tried to set up Syncthing once, got lost at "device ID pairing," and gave up. She wants to press one button and see her highlights.

**The Research Power User** -- Marcus, 41, PhD candidate. Has an rM1 loaded with 200+ annotated papers. He currently uses Syncthing and it works, but his rM1 is sluggish when Syncthing runs. He would switch to SFTP sync in a heartbeat if it means freeing 100MB of RAM, but he needs confidence that large batch syncs (200+ documents) will not hang or corrupt.

**The Privacy Advocate** -- Yuki, 28, journalist. Chose the reMarkable specifically because it has no cloud. She wants to know exactly which files are being read from her tablet, wants to see transfer progress, and needs assurance that sync is one-directional (read-only from tablet). She will not install Syncthing because it is a peer-to-peer sync tool that could theoretically write to her tablet.

**The Multi-Device User** -- David, 55, executive. Has a reMarkable at work and one at home. Uses Obsidian on a laptop that connects to whichever tablet is nearby. He needs the plugin to handle multiple sync sources cleanly and not confuse documents from different tablets.

## Feature Areas

### 1. SFTP Sync Engine

The core file transfer layer that replaces Syncthing's role entirely. Uses the existing `ssh2` library's SFTP subsystem to list, compare, and download files from the tablet's xochitl directory.

Key capabilities:
- Open an SFTP channel on the existing SSH connection (no new connections needed)
- List all files in `/home/root/.local/share/remarkable/xochitl/` recursively
- Build a remote file manifest (path, size, mtime) for comparison
- Download files sequentially to the local sync folder (respects rM1 single-core)
- Skip files that match locally (same size + mtime for metadata/content; same size for PDFs)
- Skip unnecessary file types (`.pagedata`, `.thumbnails/`)
- Report per-file and overall progress
- Handle connection drops gracefully: mark sync as incomplete, resume on next run

Connects to: Settings (reads sync config), Sync Status UI (reports progress), Extraction Pipeline (triggers after sync completes).

### 2. Incremental Sync Logic

The intelligence layer that minimizes transfer volume. Most syncs should transfer only a handful of small JSON files.

Key capabilities:
- Maintain a local file manifest (path, size, mtime, last-synced timestamp) persisted in DeviceState
- On each sync, diff remote manifest against local manifest
- Categorize files into: new, changed, unchanged, deleted-remotely
- For `.metadata` and `.content` files (small JSON, <1KB): always check mtime, re-download if newer
- For `.pdf` and `.epub` files (large, immutable after upload): download once, skip if local size matches
- For `.rm` annotation directories: compare directory listing mtimes, download changed files only
- Track sync state per sync source (for multi-tablet support)
- Expose sync stats: files checked, files transferred, bytes transferred, time elapsed

Connects to: SFTP Sync Engine (provides the transfer mechanism), DeviceState (persists manifests), Library View (shows sync freshness).

### 3. Simplified Setup Wizard

The setup wizard drops from 5 steps to 3. No more Syncthing installation, no more pairing dance, no more waiting for initial sync.

Key capabilities:
- Step 1 (Connection): Enter IP + password, verify SSH connectivity and detect device (unchanged)
- Step 2 (Detection): Show device info and preflight results (unchanged, but remove sync-method recommendation logic)
- Step 3 (First Sync): Run the first SFTP sync right in the wizard, show progress, confirm documents arrived
- Remove steps for Entware installation and Syncthing pairing entirely
- Offer a "Sync Method" toggle for users who prefer to keep Syncthing (`sftp` vs `syncthing`)
- When switching from Syncthing to SFTP: preserve existing local files, just change the sync mechanism

Connects to: SFTP Sync Engine (runs first sync), Settings (persists sync method choice), Connection Manager (reuses existing SSH workflow).

### 4. Auto-Sync Scheduler

Optional background sync that replaces Syncthing's continuous sync with a lightweight polling approach.

Key capabilities:
- Configurable interval: 5, 10, 15, 30 minutes or manual only
- Before each sync attempt: ping the tablet to check reachability (fast fail if sleeping or off-network)
- Run sync only if tablet responds; silently skip if unreachable (no error spam)
- Show last sync time and next scheduled sync in the status bar
- Cancel in-progress sync if user triggers a manual sync
- Respect Obsidian lifecycle: clear timers on plugin unload, pause during Obsidian startup

Connects to: SFTP Sync Engine (executes the sync), Settings (reads interval config), Status Bar (shows schedule info), Plugin lifecycle (manages timers).

### 5. Sync Status and Progress UI

Users should always know what the plugin is doing. This replaces the Syncthing status panel with something more useful.

Key capabilities:
- During sync: show a progress indicator in the library view header (file count, current file name, percentage)
- For large file transfers (>5MB): show per-file progress with bytes transferred
- After sync: show summary (X files synced, Y skipped, Z errors, total time)
- In the status bar: show last sync time, next scheduled sync, connection status icon
- In the existing SyncStatusModal: replace Syncthing-specific status with SFTP sync history
- Sync log: keep last 10 sync results (timestamp, files transferred, errors) for debugging

Connects to: SFTP Sync Engine (receives progress events), Library View (renders progress), Status Bar (shows summary), Settings Tab (shows sync history).

### 6. Backward Compatibility Layer

Existing Syncthing users should not be broken. The old path must remain available.

Key capabilities:
- New setting: `syncMethod: 'sftp' | 'syncthing'` (default: `'sftp'`)
- When `syncMethod` is `'syncthing'`: all existing Syncthing behavior is preserved (file watcher, Syncthing API calls, etc.)
- When `syncMethod` is `'sftp'`: Syncthing settings are hidden in the settings tab, SFTP settings are shown
- Migration: on plugin update, existing users with configured Syncthing keep `syncMethod: 'syncthing'`; new users default to `'sftp'`
- The `syncFolder` setting works identically for both methods (it is the local cache directory)
- Deprecation notice in settings for Syncthing users: "SFTP sync is simpler and uses fewer tablet resources. Consider switching."

Connects to: Settings (sync method toggle), Settings Tab (conditional UI), Setup Wizard (method selection), Plugin (routing logic).

## User Stories

### Epic 1: SFTP Sync Engine (Sprint 1)

**As Anna (Casual Reader), I want to sync my reMarkable files by clicking one button so that I do not have to install or configure any external software.**
- Clicking "Sync" in the library view opens an SFTP connection, transfers changed files, and triggers extraction
- If the tablet is not reachable, show a clear message ("Is your tablet on WiFi and awake?")
- No Syncthing, rsync, or any other tool is required
- Priority: MUST HAVE

**As Marcus (Power User), I want the sync to only download files that have changed so that syncing 200+ documents does not take forever.**
- First sync downloads all metadata and content files (~200KB total for 200 docs) plus any PDFs not already cached locally
- Subsequent syncs compare remote mtime/size against local manifest and skip unchanged files
- A sync of 200 documents where nothing changed should complete in under 10 seconds
- Priority: MUST HAVE

**As Yuki (Privacy Advocate), I want sync to be strictly read-only from the tablet so that the plugin never writes to or modifies my tablet's files.**
- The SFTP session only calls `readdir`, `stat`, and `readFile` -- never `writeFile`, `unlink`, or `mkdir` on the tablet
- No data is written to the tablet under any circumstance
- The SSH session runs no commands beyond the SFTP channel (or ping for connectivity)
- Priority: MUST HAVE

**As Marcus (Power User), I want large PDF transfers to show progress so that I know the sync has not hung.**
- Files larger than 5MB show per-file progress (bytes transferred / total bytes)
- Overall sync shows file count progress (e.g., "Syncing 3 of 47 files...")
- A stuck transfer (no bytes received for 30 seconds) is aborted and retried on next sync
- Priority: MUST HAVE

**As Anna (Casual Reader), I want sync to handle WiFi disconnections gracefully so that I never see a scary error or lose data.**
- If connection drops mid-sync, partially downloaded files are discarded (not left as corrupt partials)
- The next sync attempt re-downloads any incomplete files
- The error message says "Connection lost. Your files are safe -- sync will resume next time."
- Priority: MUST HAVE

[Sprint 1 Review Tags: `[Code Review]`]

### Epic 2: Setup Wizard Simplification (Sprint 2)

**As Anna (Casual Reader), I want setup to be just "enter password and go" so that I can start using the plugin in under 2 minutes.**
- The wizard has 3 steps: Connection, Detection, First Sync
- No mention of Syncthing, Entware, device IDs, or folder pairing
- The "First Sync" step runs SFTP sync in the wizard and shows real documents appearing
- Priority: MUST HAVE

**As David (Multi-Device User), I want to add a second tablet as a sync source without re-running the full wizard.**
- Each sync source has its own tablet IP, password, and sync folder
- Adding a source requires only: IP, password, test connection, sync
- Sources appear in the library view filter dropdown (existing behavior)
- Priority: SHOULD HAVE

**As Marcus (Power User), I want to switch from Syncthing to SFTP without losing my existing synced files.**
- Changing `syncMethod` from `syncthing` to `sftp` preserves the local `syncFolder` contents
- The next SFTP sync compares against existing local files and only downloads what is new/changed
- No re-download of the full library required
- Priority: MUST HAVE

[Sprint 2 Review Tags: `[Both]` -- UI changes to wizard + logic changes to settings migration]

### Epic 3: Auto-Sync Scheduler (Sprint 3)

**As Anna (Casual Reader), I want my highlights to appear automatically without clicking sync so that I can just open Obsidian and see new highlights.**
- Enable auto-sync in settings with a configurable interval (default: 10 minutes)
- Auto-sync silently skips if the tablet is unreachable (no error notifications)
- When auto-sync finds new documents, it triggers extraction automatically
- Priority: SHOULD HAVE

**As Marcus (Power User), I want to see when the next auto-sync will run so that I know whether to trigger a manual sync.**
- Status bar shows: "Last sync: 3 min ago | Next: in 7 min"
- Clicking the status bar element triggers an immediate sync
- During sync: status bar shows "Syncing..." with a spinner
- Priority: SHOULD HAVE

**As Yuki (Privacy Advocate), I want to disable auto-sync entirely so that the plugin never contacts my tablet without my explicit action.**
- Auto-sync is off by default (manual sync only)
- When disabled, no background timers run and no network connections are made
- The only sync trigger is the explicit "Sync" button in the library view
- Priority: MUST HAVE

[Sprint 3 Review Tags: `[Both]` -- status bar UI + scheduler logic]

### Epic 4: Sync Progress and Status UI (Sprint 4)

**As Anna (Casual Reader), I want to see sync progress in the library view so that I know something is happening.**
- During sync: the library view header shows a progress bar with "Syncing 3/47 files..."
- Individual large files show byte-level progress
- After sync: a brief summary appears ("Synced 5 new files in 12 seconds")
- Priority: SHOULD HAVE

**As Marcus (Power User), I want a sync log so that I can debug issues when documents are not appearing.**
- The SyncStatusModal shows the last 10 sync results with: timestamp, files transferred, files skipped, errors, duration
- Each error entry shows the file path and error message
- A "Copy Log" button exports the log to clipboard for bug reports
- Priority: NICE TO HAVE

**As Yuki (Privacy Advocate), I want to see exactly which files were transferred during sync so that I can verify nothing unexpected was read.**
- The sync summary lists every file that was downloaded (path and size)
- Files that were skipped (already up to date) are listed separately
- No file content is logged, only paths and sizes
- Priority: NICE TO HAVE

[Sprint 4 Review Tags: `[UI Review]`]

Design direction for Sprint 4 UI: Follow the existing library view's editorial, minimal style. Use only Obsidian CSS variables -- no custom colors, no gradients, no glassmorphism. Progress indicators should feel like native Obsidian elements (think: the search results counter, not a flashy loading bar). Sync status should be glanceable, not attention-grabbing. Reference: Obsidian's own sync status indicator in the status bar.

### Epic 5: Backward Compatibility (Sprint 5)

**As Marcus (Power User), I want to keep using Syncthing if I choose to so that my existing workflow is not disrupted.**
- A `syncMethod` setting toggles between `sftp` and `syncthing`
- When set to `syncthing`, all existing behavior is preserved exactly
- Settings tab shows the relevant settings for the active sync method
- Priority: MUST HAVE

**As a new user, I want SFTP to be the default so that I get the simplest experience.**
- New installations default to `syncMethod: 'sftp'`
- Existing installations with configured Syncthing default to `syncMethod: 'syncthing'`
- A notice in settings encourages Syncthing users to try SFTP
- Priority: MUST HAVE

[Sprint 5 Review Tags: `[Code Review]`]

## Key User Flows

### Flow 1: First-Time Setup (New User)

Anna installs the plugin and opens Obsidian. She sees a "Welcome to reMarkable Bridge" notice suggesting she run the setup wizard. She opens it.

Step 1 asks for her connection method. She picks WiFi. She enters her tablet's IP address (shown on the tablet's WiFi settings screen) and the root password (she finds it under Settings > Help > Copyrights and licenses on her tablet). She clicks "Verify Connection." The wizard connects over SSH, detects her rM2, and shows a green checkmark with "Connected to reMarkable 2 (firmware 3.8)."

Step 2 shows her device info and pre-flight checks. Everything passes. She clicks Next.

Step 3 says "Let's sync your documents." She clicks "Start Sync." A progress indicator shows files being transferred -- 12 documents, mostly small metadata files, one 40MB PDF. The PDF shows a byte-level progress bar. In 30 seconds, everything is synced. The wizard says "Found 12 documents with highlights. Setup complete!"

She clicks Finish. The library view opens in the sidebar showing her 12 documents. She clicks one and sees her highlights rendered as an Obsidian note.

### Flow 2: Daily Use with Auto-Sync

Marcus has had the plugin running for months. He reads a paper on his rM1 during his commute, highlighting key passages. When he gets to his office, his laptop and tablet are on the same WiFi.

Ten minutes later (the auto-sync interval), the plugin silently pings his tablet, finds it reachable, and opens an SFTP session. It checks the xochitl directory: 3 `.rm` files have newer timestamps (the annotations from his commute reading). It downloads them (about 50KB total) and triggers extraction. A brief "3 files synced" appears in the status bar.

Marcus opens Obsidian and sees the new highlights in his library view. He never clicked anything.

### Flow 3: Manual Sync with Progress

Yuki has auto-sync disabled. She just finished annotating a sensitive document on her reMarkable. She opens Obsidian, clicks the "Sync" button in the library view.

The library header shows "Connecting to tablet..." then "Checking 47 documents..." then "Downloading 2 changed files..." She can see that only `{uuid}.rm` and `{uuid}.metadata` are being transferred -- her PDF was already synced previously.

After 5 seconds, the summary appears: "Synced 2 files (12KB). 45 files unchanged." She clicks on the document in the library view and sees her new highlights.

### Flow 4: Switching from Syncthing to SFTP

Marcus decides to try SFTP sync to free up RAM on his rM1. He opens Settings > reMarkable Bridge and changes "Sync Method" from Syncthing to SFTP.

A confirmation dialog explains: "Switching to SFTP sync. Your existing synced files will be kept. Syncthing will no longer run on your tablet (you can uninstall it separately if you like). You may want to enable auto-sync to replace Syncthing's continuous sync."

He confirms. The settings panel updates to show SFTP-specific settings (auto-sync interval) and hides Syncthing settings (API key, URL, folder ID). His next sync uses SFTP. His existing 200+ documents are already in the local sync folder, so the first SFTP sync only downloads a few files that changed since Syncthing last ran.

## Success Metrics

1. **Setup completion rate**: Percentage of users who start the wizard and finish it. Target: >80% (up from estimated ~40% with Syncthing).

2. **Time to first highlight**: Elapsed time from plugin install to seeing the first extracted highlight note. Target: under 3 minutes (down from 15-30 minutes with Syncthing).

3. **Sync reliability**: Percentage of sync attempts that complete without error (excluding "tablet unreachable" which is expected). Target: >99%.

4. **Tablet RAM freed**: For rM1 users switching from Syncthing, measured RAM savings. Target: 50-100MB freed (the Syncthing process footprint).

5. **Incremental sync speed**: Time for a sync where nothing has changed (just remote listing + comparison). Target: under 10 seconds for libraries of 200+ documents.

6. **Zero-dependency verification**: Confirm that no new npm packages are added and no tablet-side software installation is required.

## Phased Rollout

### Phase 1: MVP -- Core SFTP Sync (Sprints 1-2)

Delivers the core value proposition: sync files from the tablet over SFTP without any external tools.

What the sprint-generator should implement:
- Sprint 1: SFTP sync engine with incremental logic, file manifest, progress reporting, error handling
- Sprint 2: Simplified 3-step setup wizard, settings migration, sync method toggle

Quality gates:
- Code-design-evaluator must pass (threshold: 70/120) after Sprint 1. Key checks: SFTP client follows single-responsibility (separate from SSH command execution), no dummy/placeholder download logic, incremental sync logic is fully implemented with real file comparison.
- Both evaluators must pass after Sprint 2. Key checks: wizard renders correctly with only 3 steps, existing Syncthing settings are preserved when sync method is syncthing, no dead Syncthing UI when sync method is sftp.

Acceptance criteria that map to evaluator dimensions:
- No new npm dependencies (spec-to-implementation match)
- SFTP channel is opened from the existing SSH client, not a separate connection (SOLID: dependency inversion)
- File manifest is a separate concern from the transfer logic (SOLID: single responsibility)
- Setup wizard conditionally renders based on sync method (no dead code paths)

### Phase 2: Growth -- Auto-Sync and Status (Sprints 3-4)

Delivers the "set it and forget it" experience and transparency features.

What the sprint-generator should implement:
- Sprint 3: Auto-sync scheduler with configurable interval, reachability check, status bar integration
- Sprint 4: Progress UI in library view, sync log in SyncStatusModal, per-file progress for large transfers

Quality gates:
- Both evaluators must pass after Sprint 3. Key checks: scheduler respects plugin lifecycle (timers cleared on unload), no polling when auto-sync is disabled.
- Design-evaluator must pass after Sprint 4 (threshold: 7.0/10). Key checks: progress UI uses only Obsidian CSS variables, no custom color palettes, progress elements feel native to Obsidian.

Acceptance criteria:
- Auto-sync timer is cleared in `onunload()` (functionality)
- Status bar updates are throttled to avoid excessive DOM writes (craft)
- Progress bar is implemented with Obsidian-native elements or CSS variables only (design quality)
- Sync log stores structured data, not formatted strings (code quality)

### Phase 3: Scale -- Polish and Multi-Device (Sprint 5)

Delivers the backward compatibility layer and polish for multi-device users.

What the sprint-generator should implement:
- Sprint 5: Backward compatibility layer (sync method toggle, settings migration, conditional UI), deprecation notices, multi-source SFTP sync

Quality gates:
- Code-design-evaluator must pass (threshold: 70/120). Key checks: sync method branching does not create god-classes, migration logic is idempotent, no Syncthing code paths execute when sync method is sftp.

Acceptance criteria:
- Existing Syncthing users are auto-detected and their sync method is preserved (migration safety)
- Settings tab hides irrelevant fields cleanly based on sync method (no dead UI)
- Multi-source support: each SyncSource can have its own sync method (extensibility)

## Risks and Open Questions

### Risks

**SFTP performance on rM1**: The rM1's Dropbear SSH server and single-core ARM CPU may bottleneck SFTP throughput. Mitigation: sequential transfers (already planned), test with real rM1 hardware to establish baseline throughput. If SFTP proves too slow for initial sync of large libraries, consider a "fast initial sync" mode that uses `scp` for bulk transfer.

**Large library initial sync**: A user with 500+ documents and many large PDFs could face a 30+ minute initial sync. Mitigation: prioritize metadata files first (so the library view populates quickly), then download PDFs in the background. Show clear progress so users know it is working.

**Tablet sleep during sync**: The reMarkable goes to sleep aggressively (2-5 minutes of inactivity). If the tablet sleeps mid-sync, the SSH connection drops. Mitigation: the sync engine already handles disconnects gracefully. Consider warning users to keep the tablet awake during first sync. Investigating whether the SSH session itself prevents sleep is an open question.

**Dropbear SFTP compatibility**: The reMarkable uses Dropbear SSH, which has its own SFTP server implementation. The `ssh2` library's SFTP client should be compatible, but edge cases (symlinks, large directory listings, special characters in filenames) need testing. Mitigation: test with real tablet data early in Sprint 1.

**Syncthing-to-SFTP migration data integrity**: When a user switches from Syncthing to SFTP, the local sync folder may have files that Syncthing wrote with different naming or permissions. Mitigation: SFTP sync should treat existing local files as a valid cache and only compare by name/size, not by any Syncthing-specific metadata.

### Open Questions

1. **Should auto-sync default to on or off?** The spec currently says off (privacy-first). But Anna's persona suggests on-by-default would reduce friction. Recommendation: default off, but the setup wizard's final step asks "Enable automatic sync?" with a clear explanation.

2. **Should the plugin offer to uninstall Syncthing from the tablet when switching to SFTP?** This would be helpful for rM1 users wanting to free RAM, but it means writing to the tablet (which contradicts the read-only principle for SFTP mode). Recommendation: provide instructions but do not automate uninstallation.

3. **Should the file manifest be stored in DeviceState or a separate file?** DeviceState is per-device and avoids conflicts, which is good. But the manifest could grow large for big libraries (500+ entries). Recommendation: store in DeviceState initially, move to a separate file if size becomes an issue.

4. **How should the plugin handle firmware updates that change the xochitl path?** The path has been stable across all known firmware versions, but it is technically an implementation detail. Mitigation: make the path configurable in advanced settings (hidden by default).

5. **What is the SFTP throughput on rM1 over WiFi vs USB?** USB should be near-gigabit. WiFi depends on the rM1's 2.4GHz radio. Need benchmarks to set realistic expectations for initial sync times.
