# Sprint 1: SSH Connectivity and Firmware Detection

## Summary of Changes

Sprint 1 implements the foundational layer for the reMarkable-Obsidian bridge: SSH connectivity to the tablet, device and firmware detection, pre-flight resource checks, and the type foundation for the extraction pipeline.

## Post-QA Fixes (2026-03-28)

Applied fixes for feedback items 1-4 from .feedback evaluation (score: 103/120, grade A).

### 1. SSHExecutor interface extracted (DIP fix)
- Added `SSHExecutor` interface to `src/ssh/ssh-client.ts` with `connect`, `execute`, `disconnect`, `ping`, `isConnected` methods.
- `ReMarkableSSHClient` now implements `SSHExecutor`.
- `connectAndVerify()` in `src/ssh/connection-manager.ts` accepts an optional `sshClient?: SSHExecutor` parameter for injection. Defaults to `new ReMarkableSSHClient(config)` for backward compatibility.
- `detector.ts` and `checks.ts` now depend on `SSHExecutor` interface instead of the concrete class.
- Exported `SSHExecutor` from barrel `src/ssh/index.ts`.

### 2. Unit tests added for detector.ts and checks.ts
- `src/device/detector.test.ts`: 18 tests covering firmware detection, device model detection (machine file, device tree, RAM heuristic fallbacks), memory parsing, and storage parsing with edge cases.
- `src/preflight/checks.test.ts`: 11 tests covering all six check types at boundary conditions (firmware too old, memory below minimum, tight memory warning, storage below minimum, root partition full, xochitl missing, unknown model) plus report metadata and formatting.
- Total tests: 62 (up from 33).

### 3. Command timeout stream leak fixed
- In `src/ssh/ssh-client.ts`, the `execute()` method's timeout handler now calls `stream.close()` on the SSH channel before rejecting. Previously the stream remained open, leaking resources on the tablet side.

### 4. Magic numbers extracted in detector.ts
- Replaced inline `600` and `1200` with named constants `RM1_MAX_RAM_MB` and `RM2_MAX_RAM_MB`.

### Item 5 (docs/) skipped per instructions -- not a code issue.

## Files Created

### Project Configuration
- `.gitignore` - Ignores node_modules, dist, .generator, IDE files
- `package.json` - Project manifest with ssh2, typescript, jest, esbuild dependencies
- `tsconfig.json` - TypeScript strict mode, ES2020 target
- `jest.config.js` - Jest config with ts-jest preset
- `esbuild.config.mjs` - Bundler config, externalizes obsidian/ssh2/electron
- `manifest.json` - Obsidian plugin manifest
- `versions.json` - Obsidian version compatibility map

### Core Types (`src/types/`)
- `device.ts` - DeviceModel, FirmwareVersion, MemoryInfo, StorageInfo, DeviceInfo, ResourceBudget types with default budgets per device generation (rM1: 64MB sync limit, 100MB min free; rM2: 128MB, 200MB)
- `config.ts` - SSHConfig, BridgeConfig types with sensible defaults (USB IP 10.11.99.1, port 22, root user)
- `errors.ts` - BridgeError class with ErrorCode enum covering SSH, device, preflight, and pipeline error categories. Each error carries a user-friendly suggestion.
- `index.ts` - Barrel export

### SSH Module (`src/ssh/`)
- `ssh-client.ts` - ReMarkableSSHClient class wrapping ssh2 with:
  - Connection with configurable timeout and reMarkable-compatible algorithm negotiation
  - Command execution with per-command timeout
  - Automatic error mapping (auth failures, timeouts, unreachable hosts) to BridgeError with contextual suggestions based on USB vs WiFi
  - Ping/health check method
  - Clean disconnect with resource cleanup
- `connection-manager.ts` - High-level orchestrator that runs the full connect-detect-preflight workflow in one call with progress callbacks for the setup wizard UI. Also provides a lightweight `testConnection()` for status bar checks.
- `index.ts` - Barrel export

### Device Detection (`src/device/`)
- `firmware.ts` - Firmware version parsing (X.Y.Z.B format), comparison, installation path routing (Toltec for 2.6-3.3, Entware for 3.4+), v6 format detection (3.0+), and compatibility warnings for untested firmware ranges
- `detector.ts` - Read-only SSH queries for:
  - Firmware version from /etc/version
  - Device model from /sys/devices/soc0/machine with fallback to device tree and RAM-based heuristic
  - Memory info from /proc/meminfo
  - Storage info via df for root and /home partitions
  - Kernel version and serial number
  - Aggregated `detectDeviceInfo()` that gathers everything
- `index.ts` - Barrel export

### Pre-flight Checks (`src/preflight/`)
- `checks.ts` - Six pre-flight checks:
  1. Firmware compatibility (min 2.6, warns on untested versions)
  2. Available memory vs resource budget
  3. /home storage (where Entware/Syncthing install)
  4. Root partition safety (warns if >95% full, never writes to it)
  5. xochitl data directory existence
  6. Device model identification
  - Returns a structured PreflightReport with pass/fail, individual check results, installation path, resource budget, and human-readable formatting
- `index.ts` - Barrel export

### Pipeline Foundation (`src/pipeline/`)
- `types.ts` - Interfaces for the extraction pipeline stages (DocumentDiscovery, HighlightExtractor, MarkdownRenderer) and data types (ReMarkableDocument, ExtractedHighlight, ExtractionResult, PipelineConfig). These are contracts that Sprint 2-3 will implement.
- `format-detector.ts` - .rm file format detection from header bytes (v3, v5, v6) with parser routing (rmscene for v6, legacy for v3/v5)
- `index.ts` - Barrel export

### Entry Point
- `src/main.ts` - Re-exports all public API symbols for the plugin

### Tests
- `src/types/errors.test.ts` - 5 tests for BridgeError behavior
- `src/device/firmware.test.ts` - 16 tests for firmware parsing, comparison, installation path routing, v6 detection, and compatibility warnings
- `src/pipeline/format-detector.test.ts` - 12 tests for .rm format detection and parser routing

## Key Design Decisions

1. **Read-only device access**: All SSH queries are diagnostic reads (cat, df, test -d). No writes to the device in Sprint 1, per the Safe Testing Strategy.
2. **Error-first design**: Every failure maps to a BridgeError with a user-facing suggestion. SSH errors are context-aware (USB vs WiFi suggestions).
3. **Resource budgets per model**: rM1 gets tighter limits (64MB Syncthing, 100MB min free) than rM2 (128MB, 200MB). Unknown devices get rM1 limits (conservative).
4. **Installation path routing**: Firmware 2.6-3.3 routes to Toltec, 3.4+ routes to Entware. Below 2.6 is unsupported with actionable error.
5. **Pipeline interfaces defined early**: Sprint 2-3 can implement DocumentDiscovery, HighlightExtractor, and MarkdownRenderer against stable contracts.
6. **ssh2 externalized**: Native .node bindings can't be bundled by esbuild; ssh2 is listed as external dependency.

## Test Results

- 3 test suites, 33 tests, all passing
- TypeScript strict-mode type checking passes with zero errors
- esbuild bundling succeeds

## Spec Compliance

- SSH connection over USB/WiFi: IMPLEMENTED (SSHConfig supports both, error messages are connection-method-aware)
- Firmware version detection: IMPLEMENTED (parses X.Y.Z.B from /etc/version)
- Device model detection: IMPLEMENTED (hardware ID files with RAM fallback)
- Pre-flight checks (RAM, storage, firmware): IMPLEMENTED (6 checks with pass/fail/warning)
- Zero cloud dependency: ENFORCED (no network calls, no telemetry, local SSH only)
- Install to /home/root only: ENFORCED (storage checks target /home, never write to root partition)
- Target firmware 3.26.0.68: SUPPORTED (routes to Entware path, in known-good range)
