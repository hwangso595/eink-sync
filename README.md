# E-Ink Sync

Sync reMarkable documents, notebooks, and highlights over SFTP or Syncthing. No reMarkable Cloud required.

## What it does

1. **Syncs** your reMarkable's document files to your computer via direct SFTP or Syncthing
2. **Extracts** text highlights from PDFs into Obsidian markdown notes with backlinks
3. **Renders** pen stroke annotations as PNG images embedded in your notes
4. **Manages** your tablet library from an Obsidian sidebar: browse, search, archive, and delete

Works with reMarkable 1 (512MB RAM) and reMarkable 2. Supports firmware 3.0+ (v6 .rm format) and legacy firmware (v3/v5 format).

---

## Why this plugin needs Python

reMarkable firmware 3.x stores annotations in v6 `.rm` files. E-Ink Sync uses [`rmscene`](https://github.com/ricklupton/rmscene) to parse those files and [`PyMuPDF`](https://pymupdf.readthedocs.io/) to match highlight coordinates with PDF text. Both are Python libraries, so extraction runs in a local Python process.

Python runs only during sync or extraction. If it is unavailable, the plugin still loads and the setup wizard explains what is missing.

---

## Prerequisites

| Requirement | Version | Why |
|-------------|---------|-----|
| **Obsidian** | 1.7.2+ | Plugin host |
| **Python** | 3.8+ | Highlight extraction and page rendering (see above) |
| **rmscene** | latest | Parses v6 .rm annotation files |
| **PyMuPDF** | latest | Extracts text from PDF pages, renders page images |
| **reMarkable SSH access** | enabled | Required for direct SFTP sync and tablet management |
| **Syncthing** _(optional)_ | any | Provides continuous background sync as an alternative to SFTP |
| **Tesseract** _(optional)_ | 5.x | Local handwriting OCR; only needed for **Search handwriting (OCR)** |

### Install Python dependencies

```bash
pip install rmscene PyMuPDF
```

### Optional: handwriting OCR

The **Search handwriting (OCR)** setting needs Tesseract plus two Python packages. Skip this unless you want handwritten pages to be searchable.

```bash
pip install pytesseract Pillow
```

Then install the Tesseract binary: `winget install UB-Mannheim.TesseractOCR` (Windows), `brew install tesseract` (macOS), or `apt install tesseract-ocr` (Linux). The plugin finds it on `PATH` or at the standard install location; set the `TESSERACT_CMD` environment variable to override.

### Windows users: disable Python Store aliases

Windows ships with `python.exe` and `python3.exe` aliases that open the Microsoft Store instead of running Python. **The plugin will silently fail to extract highlights if these are active.**

Fix: **Settings > Apps > Advanced app settings > App execution aliases** -- turn off `python.exe` and `python3.exe`.

---

## Installation

### From Community Plugins

1. Open **Settings > Community plugins** in Obsidian.
2. Select **Browse** and search for **E-Ink Sync**.
3. Select **Install**, then enable the plugin.

### From source (development)

```bash
git clone https://github.com/hwangso595/eink-sync.git
cd eink-sync
npm install
npm run build
```

Then install the plugin into your vault using the install script:

```bash
# Interactive (prompts for vault path)
npm run install-plugin

# With vault path argument
npm run install-plugin -- /path/to/your/vault

# Or via environment variable
OBSIDIAN_VAULT=/path/to/your/vault npm run install-plugin
```

The script copies `main.js`, `manifest.json`, `styles.css`, `extraction/`, and `templates/` into `<vault>/.obsidian/plugins/eink-sync/`. Re-run it after each `npm run build` to update.

**Alternative: symlink for live development**

If you prefer changes to appear immediately without re-running the install script:

```bash
# Mac/Linux
ln -s "$(pwd)" "<vault>/.obsidian/plugins/eink-sync"

# Windows (PowerShell, run as Admin)
New-Item -ItemType Junction -Path "<vault>\.obsidian\plugins\eink-sync" -Target "$(Get-Location)"
```

### First-time setup

1. Enable the plugin in Obsidian settings
2. A setup wizard opens automatically -- follow the steps to configure:
   - SSH connection to your tablet (USB or WiFi)
   - Direct SFTP or Syncthing as the sync method
   - Sync and highlight output folders
3. The plugin creates three folders in your vault:

| Folder | Default | Purpose |
|--------|---------|---------|
| **Sync** | `reMarkable/Sync` | Raw xochitl files synced from the tablet |
| **Highlights** | `reMarkable/Highlights` | Extracted markdown notes + drawing PNGs |
| **Archive** | `reMarkable/Archive` | Documents archived off the tablet |

---

## Usage

### Extracting highlights

Click the reMarkable icon in the sidebar to open the library view, then click the refresh button (top-right). This:

1. Downloads or checks for changed files using your configured sync method
2. Waits for local files to settle
3. Runs the Python extraction pipeline
4. Updates your highlight notes

You can also use the command palette: **E-Ink Sync: Extract highlights**.

### Archiving and deleting documents

Use the document actions in the library view to remove documents from the tablet:

- **Archive from tablet** keeps the complete document in your configured Archive folder and removes it from the reMarkable. With SFTP, E-Ink Sync downloads and verifies the latest document files before deleting the tablet copy. With Syncthing, moving the files into Archive propagates the deletion to the tablet.
- **Delete permanently** removes the document and all of its sidecar files from the reMarkable, Sync folders, and Archive folder. You can permanently delete an already archived document.

Archive must be outside every Sync folder so archived files are not copied back to the tablet.

### What gets extracted

| Annotation type | Extracted as |
|----------------|--------------|
| **Text-selection highlights** (long-press to select text) | Blockquoted text with PDF page link |
| **Pen strokes on PDFs** (drawing/writing over pages) | PNG image of the annotated page |
| **Notebook pages** (Quick sheets, etc.) | PNG image of each page with strokes |

**Note:** Text-selection highlights produce the best results -- you get the actual text as searchable markdown. Pen strokes (including the pen-style highlighter) are rendered as images only. The extractor does not currently OCR pen-stroke annotations to recover text.

### Output format

Each document produces a markdown file like:

```markdown
---
title: "Paper Title"
source_pdf: "[[uuid.pdf]]"
source_type: pdf
highlight_count: 3
remarkable_uuid: abc-123
---

<!-- eink-sync:start -->
### Page 5

> The highlighted text passage
> -- [[uuid.pdf#page=5|Page 5]]

![[Paper Title_p5.png|500]]
<!-- eink-sync:end -->
```

Everything between the `<!-- eink-sync:start/end -->` markers is managed by the plugin. Content outside the markers (your own notes) is preserved across re-extractions. Notes written by the pre-rename plugin (which used `<!-- remarkable-bridge:start/end -->`) are still recognised and migrated to the new markers on the next extraction.

### Trim blank page space

Notebook and quick-sheet pages are a full 1404×1872 canvas even when you only jotted a few lines at the top. With **Trim blank page space** on (the default), a page whose content sits within the top half is cropped to just below your writing, so a short quick sheet embeds a short image instead of a tall mostly-blank one. Pages that use more of the sheet, and all PDF-backed pages, are left untouched. Toggle it in **Settings → Extraction**.

### Handwriting search (OCR)

Turn on **Search handwriting (OCR)** to run local OCR over each notebook page. The recognized text is added under the page image as a callout that is **collapsed by default**, so it stays out of the way but is still found by Obsidian search:

```markdown
### Page 3

![[My Notebook_p3.png|500]]

> [!note]- Handwriting (OCR)
> Meeting notes - Project Aurora
> 1. Ship the OCR search feature
> Remember: buy milk and coffee
```

OCR is **off by default** and requires Tesseract (see Prerequisites). Recognition quality depends on how neatly the page is written; printed/neat handwriting works well, dense cursive less so. All OCR runs on your machine; no image ever leaves your network. Set the language pack(s) with the **OCR language** field (e.g. `eng`, `eng+deu`).

### Page templates

Notebook pages that use a reMarkable template (ruled lines, grid, planner, …) normally render on plain white, because the template art lives on the tablet at `/usr/share/remarkable/templates/` and isn't part of the synced document data. With **Render page templates** on (the default), the plugin fetches that art from the tablet over SFTP during sync and draws each page's template behind its strokes. `Blank` pages are unaffected, and until the art has been fetched (or for Syncthing-only setups) pages simply render on white as before. Toggle it in **Settings → Extraction**.

---

## How sync works

```
reMarkable tablet
    |
    | SFTP (direct transfer) or Syncthing (background sync)
    v
Vault/reMarkable/Sync/          <-- raw xochitl files (UUIDs)
    |
    | Python extraction pipeline
    v
Vault/reMarkable/Highlights/     <-- readable markdown + PNGs
```

All data stays on your local network. The plugin never contacts reMarkable Cloud or any external server.

### Incremental extraction

By default, the plugin only processes documents modified since the last extraction (based on the `lastModified` timestamp in each document's `.metadata` file). To force a full re-extraction of all documents, use the Sync button in the library view or the command palette.

---

## Important: folder configuration

### Changing folder paths

When you change any folder path in settings, a **migration dialog** appears:

- Shows how many files exist at the old path
- Offers three options: **Move to new location**, **Keep in old location**, or **Cancel**
- If you choose Move, all files (including subdirectories like drawings/) are relocated
- If the sync folder changes, the extraction timestamp is automatically reset so all documents in the new folder are re-processed

The file watcher is updated automatically. In Syncthing mode, the shared folder configuration is updated too.

### Archive folder location

The archive folder must **not** be inside the sync folder. If it is, Syncthing will sync archived documents back to the tablet, defeating the purpose of archiving.

### Multiple tablets / sync sources

The plugin supports **multiple sync sources** -- each with its own sync folder, Syncthing folder ID, and independent extraction timestamp.

To add a second tablet:

1. Open plugin settings and scroll to **Sync Sources**
2. Click **Add source** and enter a label (e.g., "Partner's rM2"), sync folder path, and Syncthing folder ID
3. Each source extracts independently -- extracting one does not affect the other
4. Highlight notes include a `source` field in frontmatter so you can tell which tablet produced them
5. The library view has a source filter dropdown (hidden when only one source exists)

Existing single-source setups are migrated automatically to a "Default" source on upgrade -- no reconfiguration needed.

Each source can optionally specify its own highlights subfolder to keep notes organized per tablet.

### Multiple computers (same vault via Syncthing)

If you sync your Obsidian vault between computers via Syncthing, the plugin is designed to avoid conflicts:

- **Extraction timestamps are device-scoped** -- each installation uses a random local ID, so two computers extracting at different times do not conflict on `data.json`
- **Highlight note output is deterministic** -- `date_highlighted` uses the document's modification date from the tablet (same on both machines), not the extraction date
- **No plugin files in synced folders** -- claim files and internal state are stored in `.obsidian/plugins/` (not synced by default), not in the sync/highlights folders

If you already have sync-conflict files from before this fix, you can safely delete them:

```bash
find /path/to/vault -name "*sync-conflict*" -delete
```

### Subvaults and vault isolation

All folder paths are resolved **relative to the vault root**. The plugin detects when multiple vault instances use overlapping folders:

- On load, the plugin checks for folder collisions with other vault instances
- If another vault is using the same sync or highlights folder, a **warning banner** appears in settings
- Warnings are dismissible and persisted -- they never block actions
- If a configured folder resolves to a path outside the vault root, a warning is shown

When you disable and re-enable the plugin (e.g., in a subvault), it re-reads settings from that vault's `data.json`, re-creates folders if needed, and restarts watchers. Each vault's state is fully independent.

---

## Troubleshooting

### "No new highlights found" but I added highlights

1. **Check Syncthing** -- open `http://127.0.0.1:8384` and verify the folder is "Up to Date"
2. **Check Python** -- run `python --version` (or `python3 --version`) in a terminal. If it opens the Microsoft Store, disable the aliases (see Prerequisites above)
3. **Check annotation type** -- text-selection highlights (long-press to select) produce text. Pen/highlighter strokes produce only images. If you only drew with a pen, the extraction may report 0 highlights but should still generate page drawings.
4. **Force full extraction** -- incremental mode may skip documents if their `lastModified` timestamp hasn't changed. Use the Sync button in the library or the command palette to force a full run.

### Documents not appearing in library

- Documents must have a `.metadata` and `.content` file in the sync folder
- Documents uploaded to the tablet but **never opened** will have `pageCount: 0` and empty page lists -- they appear in the library but cannot produce highlights until opened on the tablet
- Check that the sync folder path in settings matches where Syncthing actually writes files

### Old highlights still showing after deletion

When you delete highlights on the tablet and re-sync, the extraction finds 0 highlights for that document. If a highlight note already exists for it, the plugin now clears the managed highlights section (replacing it with "_No highlights or annotations found in this document._") while preserving any notes you added outside the managed markers. Brand-new documents with nothing to extract still don't create empty notes.

If you don't see the note update, re-run **Extract new highlights** (the update happens on the next extraction after the deletion syncs across).

---

## Development

```bash
npm install          # install dependencies
npm run dev          # watch mode (rebuilds on file change)
npm run build        # production build
npm test             # run test suite
npm run test:watch   # run tests in watch mode
npm run lint         # lint TypeScript source
```

### Project structure

```
src/
  plugin/             # Obsidian plugin lifecycle, settings, library view
  pipeline/           # Extraction pipeline, document discovery, markdown rendering
  ssh/                # SSH client for tablet communication
  device/             # Firmware detection, device management
  sync/               # Syncthing configuration and sync orchestration
  utils/              # Logger, shared utilities
extraction/           # Python scripts (called via child_process)
  extract.py          # Main entry point for highlight extraction
  metadata_parser.py  # xochitl .metadata/.content file parsing
  highlight_extractor.py  # GlyphRange and legacy highlight parsing
  render_pages.py     # PNG rendering of annotated pages
  legacy_rm_parser.py # v3/v5 .rm file format parser
templates/            # Handlebars template for highlight notes
```

### Architecture

The plugin has three layers:

1. **Device layer** (`ssh/`, `device/`) -- SSH connection, firmware detection, Syncthing installation on the tablet
2. **Sync layer** (`sync/`) -- Syncthing configuration, file sync orchestration
3. **Pipeline layer** (`pipeline/`, `extraction/`) -- Document discovery, Python-based highlight extraction, markdown rendering

The pipeline delegates to Python for two tasks: (1) parsing .rm files via `rmscene` and extracting highlight text via `PyMuPDF`, and (2) rendering annotated pages as PNGs. Communication is one-directional: TypeScript spawns Python with CLI arguments, Python returns JSON on stdout.

---

## Permissions & data access

E-Ink Sync needs broader access than a typical Obsidian plugin because it reads reMarkable files and communicates with the tablet. These capabilities are limited to the features listed below.

| Capability | Why it's needed |
|---|---|
| **Direct filesystem access** | Reads raw `.rm`/`.metadata`/`.content` files from the configured sync folder, which may be inside or outside the vault. It also manages the plugin's extraction runtime and writes rendered images/notes to configured vault folders. |
| **Shell execution** (`child_process`) | Spawns Python without a shell for highlight extraction (`rmscene` + `PyMuPDF`). SSH/SFTP access is limited to the configured reMarkable tablet for setup, sync, archive, delete, and restart operations. Both are essential because there is no JavaScript equivalent for parsing reMarkable's v6 `.rm` format. |
| **Dynamic feature check** (`new Function`) | Comes from the bundled `ssh2` dependency, which uses a tiny generated function only to test whether the JavaScript runtime supports BigInt exponentiation. The plugin itself does not evaluate user-provided or downloaded code. |
| **Random local installation ID** | Scopes extraction state per Obsidian installation without reading the hostname, username, environment variables, or network interfaces. The random ID never leaves the local plugin profile. |
| **Vault file enumeration** | Used by the "Send document to reMarkable" command to find PDFs/EPUBs in your vault. |

The plugin **never** makes external network requests. All sync happens over your local network via Syncthing or SSH to your tablet. No data goes to reMarkable Cloud, no telemetry, no analytics, no third-party servers.

---

## Known limitations

- **Pen-stroke text extraction**: Highlights drawn with a pen or the pen-style highlighter tool are captured as images, not text. Only text-selection highlights (GlyphRange) produce searchable text.
- **Stale notes on highlight deletion**: Documents with 0 highlights and 0 drawings are skipped, leaving old notes unchanged (see Troubleshooting above).
- **Incremental extraction uses document timestamp**: The `lastModified` field in `.metadata` may not update when annotations change, causing incremental mode to miss updates. Use full re-extraction if highlights seem stuck.
- **Same-name documents across sources**: If two tablets have a document with the same visible name, their highlight notes will overwrite each other (unless per-source subfolders are configured).

---

## License

MIT
