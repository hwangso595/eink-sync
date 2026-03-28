# ReMarkable-Obsidian Bridge: Product Specification

## Vision Statement

Transform the reMarkable tablet from an isolated reading and writing device into a seamless node in a personal knowledge management system -- where PDF highlights made with a pen on e-ink flow automatically into Obsidian as structured, linked markdown, all without touching the cloud, and all running gracefully on a 512MB RAM device from 2017.

---

## Problem Statement

reMarkable tablet users who use Obsidian face a fragmented workflow with significant friction:

1. **Highlight extraction is broken for modern firmware.** The most popular extraction tools (remarks, remarkable-highlights) do not support reMarkable software >= 3.0. The v6 .rm file format introduced in firmware 3.0 changed how annotations are stored, rendering legacy tools useless. Only the `rmscene` Python library can read the modern format, but no end-to-end pipeline exists from rmscene to Obsidian.

2. **No local-first sync path exists.** Current Obsidian-reMarkable integrations (Scrybble, obsidian-remarkable-sync) rely on reMarkable Cloud, which requires a paid subscription and sends data through third-party servers. Users who want privacy and control have no turnkey solution.

3. **reMarkable 1 is neglected.** With only 512MB RAM and a 1GHz single-core ARM A9, the rM1 is ignored by most modern tooling. Running Syncthing alongside xochitl on this hardware requires careful resource management that no existing project handles well.

4. **Toltec is incompatible with modern firmware.** Toltec only supports firmware up to 3.3.2.1666. Users on firmware 3.26.0.68 cannot use Toltec and must rely on standalone Entware or manual installations, adding setup complexity.

5. **The xochitl filesystem is hostile.** Documents are stored as flat UUID-named files with .metadata, .content, and .rm companions. There is no human-readable hierarchy. Any sync solution must understand and translate this structure.

**Evidence:** The awesome-reMarkable list on GitHub documents dozens of abandoned or partially-working tools. The Toltec issue tracker (issue #820) shows years of community frustration with firmware compatibility. The remarks project explicitly warns it does not work with firmware >= 3.0.

---

## User Personas

### 1. The Academic Reader (Primary)
- Reads 5-15 PDFs per week on their reMarkable
- Highlights key passages and makes marginal notes
- Wants highlights to appear in Obsidian automatically, linked to the source PDF
- Uses reMarkable 1 because it still works and they see no reason to upgrade
- Privacy-conscious; prefers local sync over cloud services
- Technical comfort: moderate (can follow terminal instructions but not a developer)

### 2. The PKM Power User (Secondary)
- Has an elaborate Obsidian vault with templates, dataview queries, and daily notes
- Wants reMarkable highlights to slot into existing workflows (e.g., literature note templates)
- Comfortable with configuration but wants things to "just work" after setup
- May own rM1 or rM2; wants the same tooling on either

### 3. The Privacy-First Self-Hoster (Tertiary)
- Runs a home server with Syncthing, Nextcloud, or similar
- Refuses to use reMarkable Cloud on principle
- Wants full control over the sync pipeline
- High technical comfort; will SSH into the tablet regularly
- Cares about firmware freedom; may use codexctl to manage versions

### 4. The Casual Note-Taker (Stretch)
- Mostly uses reMarkable for handwritten notebooks, not PDFs
- Occasionally wants to pull a drawing or handwritten page into Obsidian
- Lowest technical comfort; needs a one-click experience
- Most likely to abandon the tool if setup is painful

---

## Feature Areas

### Area 1: Tablet-Side Sync Engine
Lightweight file synchronization running on the reMarkable tablet itself, designed for the 512MB RAM constraint of the rM1.

**Key Capabilities:**
- Syncthing installation and configuration via Entware (bypassing Toltec for firmware >= 3.4 compatibility)
- Automated systemd service management with memory-conscious defaults
- Selective folder sync (only the xochitl data directory, not the entire filesystem)
- Watchdog process that monitors memory usage and throttles sync when xochitl needs resources
- WiFi-only sync with configurable schedules to preserve battery
- Connection via USB (10.11.99.1) or local WiFi

**Connects to:** Area 2 (the host-side pipeline reads what this area syncs)

---

### Area 2: Host-Side Extraction Pipeline
A processing pipeline that runs on the user's computer (or home server), watches for synced reMarkable files, and extracts annotations into Obsidian-compatible markdown.

**Key Capabilities:**
- File watcher that detects new or modified .rm files in the synced xochitl directory
- rmscene-based parser for v6 .rm files (firmware 3.0+) with fallback to legacy .lines parsing (firmware < 3.0)
- PDF highlight extraction using GlyphRange data from rmscene, correlated with source PDF text via PyMuPDF
- Handwritten annotation extraction as SVG or PNG images
- UUID-to-human-name resolution using .metadata files
- Folder hierarchy reconstruction from the flat UUID structure
- Configurable output: markdown files, with frontmatter, wikilinks, and optional dataview-compatible fields

**Connects to:** Area 1 (receives synced data), Area 3 (writes into the Obsidian vault)

---

### Area 3: Obsidian Integration Plugin
An Obsidian community plugin that provides the in-app experience for browsing, searching, and managing reMarkable-sourced content.

**Key Capabilities:**
- Settings panel for configuring the sync folder path, output templates, and extraction preferences
- Library view showing all reMarkable documents with sync status
- Highlight review panel: browse highlights per document, accept/edit/dismiss individual highlights before they become permanent notes
- Template system for controlling how highlights render (e.g., literature note format, Zettelkasten format, simple list)
- PDF cross-reference: clicking a highlight opens the source PDF at the highlighted location (using Obsidian's native PDF viewer or PDF++)
- Ribbon icon and command palette integration
- Status bar indicator showing sync health

**Connects to:** Area 2 (reads extraction output), Area 4 (uses templates and configuration)

---

### Area 4: Configuration and Setup System
One-time setup experience and ongoing configuration management.

**Key Capabilities:**
- Guided setup wizard in the Obsidian plugin that walks through: SSH connection to tablet, Entware installation, Syncthing pairing, and first sync
- Firmware version detection and compatibility routing (different setup paths for different firmware ranges)
- codexctl integration guidance for users who need to manage firmware versions
- Configuration file that lives in the Obsidian vault (.remarkable-bridge/config.json) for portability
- Health check command that verifies the full pipeline is working

**Connects to:** All other areas (configures and validates the entire system)

---

### Area 5: Resilience and Hardware Protection
Safeguards that protect the reMarkable 1's limited hardware and ensure graceful degradation.

**Key Capabilities:**
- Memory budget enforcement: Syncthing process limited to ~64MB RSS on rM1 (configurable per device generation)
- Sync scheduling: batch sync at intervals rather than continuous monitoring to reduce CPU and battery drain
- Crash recovery: if Syncthing or the watchdog crashes, xochitl continues normally; systemd restarts services gracefully
- Filesystem safety: never write to the xochitl directory from the host side; all operations are read-only on the tablet's document store
- Pre-flight check before installation that reports available RAM, storage, and firmware version

**Connects to:** Area 1 (enforces constraints on the sync engine), Area 4 (reports health status)

---

## User Stories

### Epic 1: Initial Setup and Connection
*Sprint 1 -- [Code Review]*

**As an Academic Reader**, I want to connect my reMarkable 1 to my computer without using reMarkable Cloud so that my documents stay private and I don't need a subscription.
- Acceptance: SSH connection established over USB or WiFi; user provides only the tablet IP and root password; connection is verified with a visual indicator in the plugin settings
- Priority: MUST HAVE

**As a PKM Power User**, I want a setup wizard in Obsidian that guides me through the entire installation so that I don't need to piece together instructions from GitHub READMEs.
- Acceptance: Step-by-step modal in Obsidian; each step has a "Verify" button that checks success before proceeding; wizard handles errors with actionable messages; completes in under 10 minutes on a good connection
- Priority: MUST HAVE

**As a Privacy-First Self-Hoster**, I want the setup process to install Entware and Syncthing on my tablet automatically so that I can avoid the Toltec dependency and work with firmware 3.26.0.68.
- Acceptance: Plugin triggers SSH commands to install Entware from Evidlo/remarkable_entware; installs Syncthing via opkg; creates systemd service; works on firmware 3.3+ (Toltec path) and 3.4+ (Entware-only path); detects firmware version and routes accordingly
- Priority: MUST HAVE

**As a Casual Note-Taker**, I want to know upfront if my tablet is compatible before starting setup so that I don't waste time on an unsupported configuration.
- Acceptance: Pre-flight check reports firmware version, available RAM, available storage, and device generation; clear pass/fail indicator with explanations for any failures
- Priority: SHOULD HAVE

---

### Epic 2: File Synchronization
*Sprint 2 -- [Code Review]*

**As an Academic Reader**, I want my reMarkable documents to sync to my computer automatically over my home WiFi so that I can annotate a PDF on the couch and find the highlights on my computer later.
- Acceptance: Syncthing runs as a systemd service on the tablet; syncs the xochitl directory to a configurable local folder on the host; sync occurs within 5 minutes of a document change when both devices are on the same network
- Priority: MUST HAVE

**As a Privacy-First Self-Hoster**, I want Syncthing configured for local-only discovery so that no data leaves my network, not even to Syncthing relay servers.
- Acceptance: Syncthing configured with globalAnnounceEnabled=false, relaysEnabled=false; discovery limited to local subnet; explicit TCP address configuration for the host device
- Priority: MUST HAVE

**As an Academic Reader**, I want sync to happen without making my reMarkable slow or unresponsive so that my reading and writing experience is not degraded.
- Acceptance: Syncthing process RSS memory stays under 64MB on rM1 (128MB on rM2); CPU usage throttled during active pen input; sync pauses automatically if free RAM drops below 100MB on rM1; no perceptible UI lag during sync
- Priority: MUST HAVE

**As a PKM Power User**, I want to see sync status from within Obsidian so that I know whether my latest highlights have arrived.
- Acceptance: Status bar widget shows last sync time, number of pending documents, and connection health; clicking opens a detail panel
- Priority: SHOULD HAVE

**As any user**, I want sync to be one-directional (tablet to computer) by default so that I cannot accidentally corrupt my tablet's filesystem.
- Acceptance: Syncthing folder configured as "Send Only" on the tablet side; host side is "Receive Only"; no writes to xochitl from the host; option to enable bidirectional sync for advanced users with explicit warning
- Priority: MUST HAVE

---

### Epic 3: PDF Highlight Extraction
*Sprint 3 -- [Both]*

**As an Academic Reader**, I want my PDF highlights to be extracted as text and saved as markdown notes in my Obsidian vault so that I can search, link, and reference them like any other note.
- Acceptance: GlyphRange data from v6 .rm files parsed via rmscene; highlighted text regions correlated with PDF text content using PyMuPDF; output as markdown file with frontmatter (title, author, date highlighted, source PDF path); each highlight is a blockquote with page number reference; accuracy >= 95% for standard text highlights (not handwritten annotations)
- Priority: MUST HAVE

**As a PKM Power User**, I want highlight notes to follow my custom template so that they integrate with my existing literature note workflow.
- Acceptance: Configurable Handlebars/Mustache-style template with variables: {{title}}, {{author}}, {{highlights}}, {{date}}, {{source_pdf}}, {{page}}, {{tags}}; default template provided; template stored in vault for version control; dataview-compatible frontmatter by default
- Priority: MUST HAVE

**As an Academic Reader**, I want to see which highlights are new since my last review so that I can process them incrementally rather than re-reading everything.
- Acceptance: Each extraction run is timestamped; new highlights since last run are marked with a configurable indicator (e.g., #new tag or callout block); a "highlight inbox" note collects all unprocessed highlights across all documents
- Priority: SHOULD HAVE

**As a PKM Power User**, I want highlight notes to link back to the exact page and position in the PDF so that I can jump to context with one click.
- Acceptance: Each highlight includes a PDF++ compatible link (e.g., [[file.pdf#page=5]]) that opens in PDF++ at the correct page with the highlight visible; leverages PDF++ annotation features for in-context viewing
- Priority: MUST HAVE

**As an Academic Reader**, I want highlights from the same PDF to be grouped in a single note rather than scattered across many files so that I have one literature note per source.
- Acceptance: All highlights from one PDF consolidated into a single markdown file; file named after the document's visibleName from .metadata; updates append new highlights without overwriting manual edits the user has made to the note
- Priority: MUST HAVE

---

### Epic 4: Handwritten Annotation Support
*Sprint 4 -- [Both]*

**As a Casual Note-Taker**, I want my handwritten notebook pages to appear as images in my Obsidian vault so that I can reference my sketches and handwritten notes alongside typed content.
- Acceptance: Each notebook page rendered as SVG (preferred, vector) or PNG (fallback, raster); stored in a configurable attachments folder; linked from a parent markdown note that mirrors the notebook's name and page structure
- Priority: SHOULD HAVE

**As an Academic Reader**, I want handwritten marginal notes on PDFs to appear alongside the text highlights so that I get the full picture of my annotations.
- Acceptance: Scribble/drawing layers from .rm files rendered as inline images within the highlight note, positioned near the corresponding page's text highlights; pen color and thickness preserved in SVG output
- Priority: NICE TO HAVE

**As a PKM Power User**, I want OCR on my handwritten notes so that they become searchable in Obsidian.
- Acceptance: Optional integration with a local OCR engine (Tesseract or similar); OCR text appended as alt-text on images or as a collapsible section below the image; user can enable/disable per notebook
- Priority: NICE TO HAVE

---

### Epic 5: Obsidian Plugin Experience
*Sprint 5 -- [UI Review]*

**As an Academic Reader**, I want a library view in Obsidian that shows all my reMarkable documents so that I can browse what's on my tablet without picking up the tablet.
- Acceptance: Sidebar panel listing all synced documents grouped by folder (reconstructed from UUID/.metadata hierarchy); shows document name, type (PDF/EPUB/notebook), last modified date, and highlight count; searchable and sortable
- Priority: SHOULD HAVE

**As a PKM Power User**, I want a highlight review workflow where I can accept, edit, or dismiss individual highlights before they become permanent notes so that I maintain quality control over what enters my vault.
- Acceptance: Modal or panel showing pending highlights with the original PDF context; "Accept" adds to the literature note; "Edit" opens inline editor; "Dismiss" marks as ignored (can be undone); batch accept option for quick processing
- Priority: SHOULD HAVE

**As any user**, I want the plugin to have a clean, understated UI that fits Obsidian's aesthetic so that it feels native rather than bolted on.
- Acceptance: Uses Obsidian's native UI components (settings, modals, sidebar panels); no custom color palette; respects dark/light theme; typography matches vault content; no gradients, glassmorphism, or flashy animations
- **Design Direction:** Editorial and minimal, like Obsidian itself. Think "well-organized reading list" not "dashboard." Use Obsidian's native CSS variables for all styling. The library view should feel like a file explorer, not a media browser. Highlight review should feel like processing email -- focused and efficient.
- Priority: SHOULD HAVE

**As a Privacy-First Self-Hoster**, I want all processing to happen locally with no network calls from the plugin so that I can verify nothing phones home.
- Acceptance: Zero network requests from the Obsidian plugin; all data read from the local synced folder; no analytics, telemetry, or update checks beyond Obsidian's built-in plugin update mechanism
- Priority: MUST HAVE

---

### Epic 6: Firmware Compatibility and Resilience
*Sprint 6 -- [Code Review]*

**As any user**, I want this tool to work with my current firmware version without requiring a downgrade so that I don't risk bricking my device.
- Acceptance: Firmware 3.0 through latest (starting with 3.26.0.68) supported via Entware path; firmware 2.6 through 3.3 supported via Toltec path; firmware detection is automatic; no firmware modification required; graceful error if firmware is truly unsupported
- Priority: MUST HAVE

**As a Privacy-First Self-Hoster**, I want the tablet-side components to survive firmware updates so that I don't have to reinstall everything after each OTA update.
- Acceptance: Entware installed to /home partition (persists across updates); Syncthing binary and config in /home/root/.entware (not /opt on root partition); systemd service file backed up and restoration documented; post-update health check available
- Priority: MUST HAVE

**As an Academic Reader**, I want the extraction pipeline to handle both old (v3/v5 .lines) and new (v6 .rm) file formats so that my old annotations are not lost when I upgrade firmware.
- Acceptance: File format detected per-document based on header bytes; v6 parsed via rmscene; legacy formats parsed via direct binary reader; both paths produce identical markdown output structure; mixed-format libraries handled seamlessly
- Priority: MUST HAVE

**As any user**, I want the system to degrade gracefully if something breaks so that a sync failure does not corrupt my tablet or vault.
- Acceptance: Extraction failures logged but do not halt the pipeline; partial extractions saved with a warning marker; tablet-side Syncthing crash does not affect xochitl; vault-side writes are atomic (write to temp file, then rename); existing notes never overwritten without backup
- Priority: MUST HAVE

---

## Key User Flows

### Flow 1: First-Time Setup (10 minutes)

The user installs the Obsidian plugin from the community plugin browser. On first open, a setup wizard appears. Step 1 asks them to connect their reMarkable via USB cable and enter the root password (found in Settings > Help > About > Copyrights and Licenses). The plugin verifies SSH connectivity and displays the firmware version and device model. Step 2 explains that it will install a lightweight file sync tool (Syncthing) on the tablet and asks for confirmation. The user clicks "Install" and watches a progress log. Step 3 pairs Syncthing between the tablet and computer, configuring local-only discovery. Step 4 triggers the first sync and shows documents appearing in real-time. Step 5 lets the user choose an output folder in their vault and pick a highlight template. The wizard completes with a summary card showing the full pipeline health status. The entire flow takes under 10 minutes.

### Flow 2: Daily Highlight Workflow (Automatic)

The user reads a PDF on their reMarkable during their morning commute (offline). When they return home and the tablet connects to WiFi, Syncthing detects modified .rm files and syncs them to the computer within 5 minutes. The host-side extraction pipeline (running as a background process or triggered by Obsidian) detects the new files, parses the v6 .rm data, extracts highlighted text regions using rmscene and PyMuPDF, resolves the document name from .metadata, and writes a markdown note into the vault. When the user opens Obsidian, they see a notification: "3 new highlights from 'Thinking, Fast and Slow.'" They click through to the literature note, review the highlights (each is a blockquote with a page-number link to the PDF), make a small edit to one, and continue their day. The whole post-sync experience takes under 2 minutes.

### Flow 3: Reviewing and Curating Highlights

The user opens the plugin's highlight review panel from the ribbon icon. They see a list of documents with unprocessed highlights, sorted by most recent. They click on a paper they highlighted yesterday. A split view shows the original PDF on the left and extracted highlights on the right. They scroll through, accepting most highlights with a keyboard shortcut, editing one to add a personal note, and dismissing a false positive (an accidental mark). When done, they close the panel and the accepted highlights are now in their literature note, ready to be linked from other notes.

### Flow 4: Recovery After Firmware Update

The user's reMarkable auto-updates from 3.26 to 3.28. When they next connect to WiFi, Syncthing fails to start because the systemd service was overwritten. The Obsidian plugin detects the connectivity loss and shows a warning: "reMarkable not responding. Last sync: 2 days ago." The user clicks "Troubleshoot" and the plugin guides them through re-enabling the systemd service via SSH (one command). Syncthing restarts, catches up on missed syncs, and the pipeline resumes. Total recovery time: 3 minutes.

---

## Success Metrics

1. **Setup completion rate**: >= 80% of users who start the setup wizard complete it without abandoning or seeking external help. Measured by telemetry-free local completion flags.

2. **Highlight extraction accuracy**: >= 95% of text highlights on standard PDFs (not scanned images) are correctly extracted as readable text. Measured by user-reported accuracy in a sample of 100 documents.

3. **Sync latency**: Median time from saving a highlight on the tablet to the markdown note appearing in Obsidian is under 10 minutes when both devices are on the same network. Measured by timestamp comparison.

4. **Resource overhead on rM1**: Syncthing process RSS memory stays under 64MB; no user-perceptible latency increase in xochitl during sync. Measured by on-device monitoring during testing.

5. **Firmware compatibility breadth**: Works on firmware versions 3.0 through latest without modification. Measured by testing matrix across at least 5 firmware versions.

6. **Retention**: >= 60% of users who complete setup are still syncing highlights 30 days later. Measured by last-sync timestamp in plugin settings.

---

## Phased Rollout

### Phase 1: MVP -- Core Extraction Pipeline
**Goal:** Prove the core value proposition: highlights on reMarkable become markdown in Obsidian.
**What to implement:**
- Sprint 1: SSH connectivity and firmware detection (Epic 1, must-have stories)
- Sprint 2: One-directional Syncthing setup with memory constraints (Epic 2, must-have stories)
- Sprint 3: PDF highlight extraction via rmscene + PyMuPDF with default template (Epic 3, must-have stories)

**Quality gates:**
- [Code Review] after Sprint 1 and 2: SOLID compliance, no dummy code, proper error handling for SSH/network operations, clean separation between tablet-side and host-side concerns
- [Both] after Sprint 3: Extraction logic must be well-architected (code review) AND the resulting markdown output must be clean and useful (design review of the output format and template)
- Pass threshold: Code >= 70/120, Design >= 7.0/10

**Standalone value:** User can highlight a PDF on reMarkable, wait for sync, and find a well-formatted markdown note in their Obsidian vault. Manual setup via terminal is acceptable in Phase 1.

---

### Phase 2: Growth -- Obsidian Plugin Experience
**Goal:** Make the experience accessible to non-technical users and delightful for power users.
**What to implement:**
- Sprint 4: Obsidian plugin skeleton with settings panel and setup wizard (Epic 1 should-have + Epic 5 setup stories)
- Sprint 5: Library view and sync status indicators (Epic 5 should-have stories)
- Sprint 6: Highlight review workflow and custom templates (Epic 3 should-have + Epic 5 review stories)

**Quality gates:**
- [UI Review] after Sprint 5: Library view must feel native to Obsidian; no generic AI-generated UI patterns; must respect light/dark themes
- [Both] after Sprint 6: Review workflow must be functional AND well-coded; template system must be extensible without being over-engineered
- Pass threshold: Code >= 70/120, Design >= 7.0/10

**Standalone value:** Non-technical users can set up the full pipeline through a guided wizard in Obsidian. Power users can customize templates and review highlights efficiently.

---

### Phase 3: Scale -- Robustness and Extended Features
**Goal:** Handle edge cases, support all reMarkable variants, and add differentiating features.
**What to implement:**
- Sprint 7: Firmware compatibility layer -- legacy format support, firmware update recovery, codexctl guidance (Epic 6 stories)
- Sprint 8: Handwritten annotation support -- SVG/PNG rendering, inline images in notes (Epic 4 stories)
- Sprint 9: Optional OCR integration and advanced features (Epic 4 nice-to-have stories, any remaining stretch stories)

**Quality gates:**
- [Code Review] after Sprint 7: Compatibility layer must be well-abstracted; format detection must be robust; error handling must be comprehensive
- [Both] after Sprint 8: SVG rendering quality matters (design review) AND the rendering pipeline must be efficient and well-structured (code review)
- Pass threshold: Code >= 70/120, Design >= 7.0/10

**Standalone value:** Works reliably across all firmware versions and reMarkable models. Handwritten content flows into Obsidian alongside text highlights. The tool becomes the definitive reMarkable-to-Obsidian bridge.

---

## Hard Constraints

1. **ZERO reMarkable Cloud dependency.** The system must NEVER communicate with reMarkable's servers. No subscriptions, no cloud API calls, no telemetry. The only permitted internet traffic from the tablet is Syncthing or rsync to the user's own devices on the local network.
2. **Cannot softlock the reMarkable.** Every tablet-side operation must be reversible. See "Safe Testing Strategy" section below.
3. **PDF++ integration.** Use the PDF++ Obsidian plugin (RyotaUshio/obsidian-pdf-plus) for PDF cross-referencing and navigation rather than building custom PDF viewing.

---

## Safe Testing Strategy

### How to test without softlocking your reMarkable

**What can softlock a reMarkable:**
- Corrupting `/usr/share/remarkable/xochitl` (the UI binary)
- Filling the root partition (`/`) — only ~200MB free typically
- Breaking the boot partition or systemd init
- Modifying xochitl's data files in a way that crashes the UI on startup

**What is SAFE and fully reversible:**
- All our changes go to `/home/root/` which is on the `/home` partition (separate from root)
- Syncthing/Entware install to `/home/root/.entware` — deleting this folder fully uninstalls
- Systemd services we create can be disabled with one SSH command
- We NEVER write to the xochitl data directory from the host side (read-only sync)
- We NEVER modify system files on the root partition

**Testing protocol (ordered from safest to riskiest):**

1. **Desktop-only testing (zero tablet risk):**
   - Copy `.rm` files and `.metadata` files from the tablet to your PC via SCP
   - Run the entire extraction pipeline on copies — no tablet involvement
   - This tests 80% of the system (rmscene parsing, text extraction, markdown generation)

2. **Read-only SSH testing:**
   - SSH in and run diagnostic commands only (`cat`, `ls`, `free -m`, `uname -a`)
   - Check firmware version, available RAM, disk space
   - Read xochitl files without modifying anything
   - **Rollback:** Nothing to roll back — you only read

3. **Entware installation (low risk):**
   - Installs entirely to `/home/root/.entware`
   - **Rollback:** `rm -rf /home/root/.entware` and remove the PATH export from `.bashrc`
   - **Test:** `opkg list-installed` to verify, then try installing a small package like `htop`

4. **Syncthing installation (medium risk):**
   - Install via `opkg install syncthing`
   - Run manually first (`syncthing -no-browser`) — do NOT enable systemd service yet
   - Monitor with `free -m` and `top` to check memory usage
   - **Rollback:** `Ctrl+C` to stop, `opkg remove syncthing` to uninstall
   - **If too heavy for rM1:** Fall back to rsync cron job (uses ~2MB RAM vs Syncthing's ~50MB)

5. **Systemd service (medium risk):**
   - Only after manual Syncthing works well
   - Create service file, enable it, test restart behavior
   - **Rollback:** `systemctl disable --now remarkable-sync && rm /etc/systemd/system/remarkable-sync.service`

**Emergency recovery if something goes wrong:**
- reMarkable 1 can always be factory reset via Settings > General > Factory Reset
- If the UI crashes on boot, SSH is still available (it runs independently of xochitl)
- If SSH is up, you can always undo changes manually
- As absolute last resort: reflash the firmware via USB using the reMarkable recovery tool

---

## Risks and Open Questions

### High Risk

1. **Firmware 3.26.0.68 Entware compatibility is unverified.** Entware has been tested on firmware up to ~3.11. Firmware 3.26 may have changed partition layout, systemd behavior, or SSH access patterns. **Mitigation:** Test on actual device before committing to the architecture; have a fallback plan using rsync-over-SSH instead of Syncthing if Entware cannot be installed.

2. **rmscene may not cover all highlight scenarios on firmware 3.26.** The library is community-maintained and best tested on firmware 3.2-3.6. Newer firmware may introduce new block types or format changes. **Mitigation:** rmscene handles unknown blocks gracefully (UnreadableBlock); build a reporting mechanism so users can flag extraction failures for investigation.

3. **Syncthing on rM1 may be too resource-heavy.** Even with memory limits, the 1GHz single-core ARM A9 may struggle with Syncthing's overhead. **Mitigation:** Profile on actual hardware; if Syncthing is too heavy, fall back to a lightweight rsync cron job instead.

### Medium Risk

4. **reMarkable firmware updates may break the tablet-side setup.** OTA updates can overwrite systemd services and may change the filesystem layout. **Mitigation:** Install to /home partition; document recovery steps; consider recommending users disable auto-update via codexctl.

5. **PDF text extraction accuracy depends on PDF quality.** Scanned PDFs without OCR layers will produce poor or no text extraction. **Mitigation:** Detect non-text PDFs and warn the user; offer optional OCR pre-processing in Phase 3.

6. **The xochitl restart requirement after external file changes is disruptive.** If we ever need to write files back to the tablet (bidirectional sync), xochitl must be restarted for changes to appear. **Mitigation:** Phase 1 is read-only from the tablet; bidirectional sync is an explicit opt-in with clear warnings.

### Open Questions

- **Should the host-side pipeline be a standalone daemon or embedded in the Obsidian plugin?** Running as a daemon allows extraction to happen even when Obsidian is closed but adds installation complexity. Embedding in the plugin is simpler but only works when Obsidian is open. Recommendation: Start embedded in the plugin (Phase 1-2), extract to a standalone service in Phase 3 if needed.

- **Should we support rmfakecloud as an alternative to Syncthing?** rmfakecloud provides a self-hosted reMarkable Cloud replacement that the tablet can sync to natively (no Entware needed). This would be simpler on the tablet side but more complex on the server side. Worth investigating as a Phase 3 alternative.

- **What is the right behavior when highlights overlap or are edited on the tablet?** If a user highlights a passage, syncs, then extends the highlight, should the extracted text be updated or should both versions be preserved? Recommendation: Update in place with a revision history comment in the markdown.

- **Should we support EPUB annotations or only PDF?** reMarkable converts EPUBs to PDF internally. We could extract from the converted PDF, but accuracy may vary. Recommendation: PDF-first in Phase 1; investigate EPUB in Phase 3.

- **What is the licensing model?** The existing ecosystem is split between open-source (remarks, rmscene) and paid (Scrybble). Recommendation: Fully open-source (MIT or GPL-3.0) to build community trust and encourage contributions, especially from the reMarkable hacking community.

---

## Technical Research Summary

This section captures key findings from research to inform implementation decisions. These are informational -- the spec intentionally avoids prescribing technical architecture.

### reMarkable File System
- Documents stored at: `/home/root/.local/share/remarkable/xochitl/`
- Flat structure: each document is a UUID with companion files (.metadata, .content, .rm, .pdf, .thumbnails/)
- .metadata contains visibleName, parent folder UUID, document type
- .content contains page UUIDs and tool settings
- One .rm file per page, stored in UUID/ subdirectory

### .rm File Format Evolution
- **v3/v5 (.lines):** Binary format with x, y, speed, direction, width, pressure per point; one file per page
- **v6 (.rm, firmware 3.0+):** New binary format with scene blocks including SceneLineItems, Text blocks, GlyphRange (PDF highlights), SceneGroupItemBlock, SceneTombstoneItemBlock
- **rmscene** (Python) is the only maintained library for v6 format

### Key Libraries
- **rmscene** (ricklupton): Reads v6 .rm files; supports GlyphRange for highlights; compatible with firmware 3.2-3.6+; graceful degradation for unknown blocks
- **rmc** (ricklupton): Converts .rm to SVG, PDF, and simple Markdown
- **remarks** (lucasrla): Full extraction pipeline for firmware < 3.0 only; exports to Markdown/PDF/PNG/SVG; depends on PyMuPDF and Shapely
- **remarks v6_with_rmscene branch** (Scrybbling-together): Work-in-progress fork adding v6 support via rmscene
- **PyMuPDF**: PDF text extraction and manipulation; needed to correlate GlyphRange coordinates with actual text content

### Tablet-Side Infrastructure
- **Toltec**: Package manager; supports firmware 2.6.1.71 to 3.3.2.1666 only; NOT compatible with firmware 3.26
- **Entware** (Evidlo/remarkable_entware): Lightweight package manager; installs to /home/root/.entware; more firmware-agnostic
- **Syncthing**: Available via opkg; needs ~50-100MB RAM; configurable for local-only discovery
- **codexctl**: Firmware version management tool; can list, download, install firmware versions; useful for users who need specific firmware

### Existing Obsidian Integrations
- **Scrybble**: Paid SaaS; syncs via reMarkable Cloud; most polished but requires subscription
- **obsidian-remarkable-sync** (dsebastien): Free; syncs via reMarkable Cloud API; downloads as images
- **obsidian-remarkable** (cobalamin): Free; USB/WiFi screenshot capture only; no annotation extraction
- **ReMarkable Sync** (mightytreefolk): Free; renders pen strokes as PDFs; uses Cloud API
- **None of these provide local-first Syncthing-based sync with highlight text extraction**

### Obsidian Plugin Development
- TypeScript with the obsidian API
- Use this.registerEvent() for cleanup; Vault.process() for file modifications; requestUrl() for any network calls
- ESLint with obsidian-specific rules
- manifest.json + versions.json for release management

---

## Sprint Dependency Map

```
Sprint 1 (SSH + firmware detection)
  |
  v
Sprint 2 (Syncthing setup + memory management)
  |
  v
Sprint 3 (PDF highlight extraction pipeline) -----> Sprint 4 (Obsidian plugin skeleton + wizard)
                                                        |
                                                        v
                                                     Sprint 5 (Library view + status)
                                                        |
                                                        v
                                                     Sprint 6 (Highlight review + templates)
                                                        |
                                                        v
                                                     Sprint 7 (Firmware compat layer)
                                                        |
                                                        v
                                                     Sprint 8 (Handwriting SVG/PNG)
                                                        |
                                                        v
                                                     Sprint 9 (OCR + advanced)
```

Sprints 1-3 are sequential (hard dependencies). Sprint 4 depends on Sprint 3. Sprints 4-6 are sequential. Sprints 7-9 can be parallelized if resources allow.
