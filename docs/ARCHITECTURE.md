# reMarkable-Obsidian Bridge -- Architecture

## Overview

The plugin extracts highlights and annotations from a reMarkable tablet
and renders them as Markdown notes inside an Obsidian vault. All data
stays local -- no cloud services, no telemetry.

## Three-Layer Architecture

```
+-----------------+     +------------------+     +--------------------+
|  Device Layer   | --> |   Sync Layer     | --> |  Pipeline Layer    |
|  (SSH / tablet) |     | (SFTP/Syncthing) |     | (extraction + MD)  |
+-----------------+     +------------------+     +--------------------+
```

### 1. Device Layer (`src/ssh/`, `src/device/`)

Handles direct communication with the reMarkable tablet over SSH.

- **ReMarkableSSHClient** -- thin wrapper around ssh2; implements `SSHExecutor`
- **connection-manager** -- connect, verify device model/firmware, run preflight
- **detector / firmware** -- identify reMarkable 1 vs 2, parse firmware versions

### 2. Sync Layer (`src/sync/`)

Transfers xochitl files from the tablet to a local sync folder.

Two transport backends share a common **SyncProvider** interface:

| Provider | Transport | When to use |
|---|---|---|
| `SftpProvider` | SFTP over SSH | Direct USB or WiFi connection |
| `SyncthingProvider` | Syncthing REST API | Always-on background sync |

- **SftpSyncEngine** -- incremental SFTP download (only changed files)
- **installer / service-manager** -- install Syncthing + Entware on tablet
- **sync-manager** -- orchestrates initial Syncthing setup

### 3. Pipeline Layer (`src/pipeline/`)

Processes the local xochitl files into Obsidian-ready Markdown.

- **extraction-pipeline** -- discovers documents, delegates to Python
- **python-bridge** -- spawns the Python extraction scripts
- **markdown-renderer** -- converts extraction output to Markdown via templates
- **template-engine** -- Handlebars-style template processing
- **file-watcher** -- watches sync folder for changes, triggers auto-extraction

Python scripts (`extraction/`):
- `extract.py` -- reads `.rm` stroke data and `.highlights` JSON
- `metadata_parser.py` -- parses xochitl `.metadata` and `.content` files

## Plugin Decomposition (`src/plugin/`)

The main `plugin.ts` delegates to focused modules:

| Module | Responsibility |
|---|---|
| **SyncCoordinator** | Owns the auto-sync timer; prevents overlapping SFTP runs |
| **DeviceStateManager** | Per-device state persistence (`device-state-<hostname>.json`) |
| **StatusBarManager** | Status bar element, periodic health checks, document count |
| **settings-tab** | Obsidian settings UI |
| **setup-wizard** | First-run configuration modal |
| **library-view** | Sidebar showing synced documents |
| **vault-isolation** | Claim files to detect folder collisions between vaults |
| **archive-manager** | Archive old documents on tablet to free storage |

## Data Flow

```
reMarkable tablet
      |
      | SSH (SFTP) or Syncthing
      v
Local sync folder (xochitl files: .metadata, .content, .rm, .highlights)
      |
      | Python extraction scripts
      v
Structured JSON (highlights, page text, stroke data)
      |
      | Markdown renderer + template engine
      v
Obsidian vault / Highlights folder (one .md note per document)
```

## Key Design Decisions

### Per-device state files

Extraction timestamps and path hashes are stored in
`device-state-<hostname>.json` rather than Obsidian's `data.json`.
This prevents Syncthing conflicts when multiple computers share the
same vault -- each machine tracks its own extraction progress.

### Deterministic output

The Markdown renderer produces deterministic output for the same input.
This means re-running extraction on unchanged documents produces
identical files, avoiding unnecessary git diffs.

### SyncProvider abstraction

SFTP and Syncthing have fundamentally different models (pull vs push),
but both expose the same `SyncProvider` interface. The plugin code
never branches on transport type -- it calls `provider.sync()` and
the provider handles the details.

### Privacy-first / local-only

No network calls except SSH to the user's own tablet and localhost
Syncthing API. No analytics, telemetry, or update checks. USB-only
mode disables all WiFi operations.

### Safety

The plugin never modifies files on the reMarkable's root filesystem
(except for optional Syncthing installation and document archiving).
Archive operations are gated behind storage-threshold checks to
prevent accidental data loss.
