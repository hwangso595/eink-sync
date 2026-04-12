/**
 * Structured error types for the reMarkable-Obsidian bridge.
 *
 * Each error carries a machine-readable code and a human-readable message
 * suitable for display in the Obsidian plugin UI.
 */

export enum ErrorCode {
  // SSH errors
  SSH_CONNECTION_REFUSED = 'SSH_CONNECTION_REFUSED',
  SSH_AUTH_FAILED = 'SSH_AUTH_FAILED',
  SSH_TIMEOUT = 'SSH_TIMEOUT',
  SSH_HOST_UNREACHABLE = 'SSH_HOST_UNREACHABLE',
  SSH_COMMAND_FAILED = 'SSH_COMMAND_FAILED',

  // Device errors
  DEVICE_NOT_REMARKABLE = 'DEVICE_NOT_REMARKABLE',
  FIRMWARE_PARSE_FAILED = 'FIRMWARE_PARSE_FAILED',
  FIRMWARE_UNSUPPORTED = 'FIRMWARE_UNSUPPORTED',

  // Preflight errors
  INSUFFICIENT_MEMORY = 'INSUFFICIENT_MEMORY',
  INSUFFICIENT_STORAGE = 'INSUFFICIENT_STORAGE',
  PREFLIGHT_CHECK_FAILED = 'PREFLIGHT_CHECK_FAILED',

  // Sync errors
  SYNC_INSTALL_FAILED = 'SYNC_INSTALL_FAILED',
  SYNC_CONFIG_FAILED = 'SYNC_CONFIG_FAILED',
  SYNC_SERVICE_FAILED = 'SYNC_SERVICE_FAILED',
  SYNC_MEMORY_EXCEEDED = 'SYNC_MEMORY_EXCEEDED',
  SYNC_RSYNC_FAILED = 'SYNC_RSYNC_FAILED',
  SYNC_NOT_INSTALLED = 'SYNC_NOT_INSTALLED',

  // Pipeline errors
  PIPELINE_NOT_CONFIGURED = 'PIPELINE_NOT_CONFIGURED',
  XOCHITL_PATH_NOT_FOUND = 'XOCHITL_PATH_NOT_FOUND',
  SYNC_FOLDER_EMPTY = 'SYNC_FOLDER_EMPTY',

  // Extraction errors (Sprint 3)
  PYTHON_NOT_FOUND = 'PYTHON_NOT_FOUND',
  PYTHON_DEPS_MISSING = 'PYTHON_DEPS_MISSING',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  EXTRACTION_TIMEOUT = 'EXTRACTION_TIMEOUT',
  MARKDOWN_WRITE_FAILED = 'MARKDOWN_WRITE_FAILED',

  // Firmware compatibility errors (Sprint 7)
  FIRMWARE_UPDATE_DETECTED = 'FIRMWARE_UPDATE_DETECTED',
  ENTWARE_NOT_PERSISTENT = 'ENTWARE_NOT_PERSISTENT',
  LEGACY_FORMAT_UNSUPPORTED = 'LEGACY_FORMAT_UNSUPPORTED',
  HEALTH_CHECK_FAILED = 'HEALTH_CHECK_FAILED',
}

export class BridgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly suggestion?: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  /** Format for display in the plugin UI. */
  toUserMessage(): string {
    const parts = [this.message];
    if (this.suggestion) {
      parts.push(`Suggestion: ${this.suggestion}`);
    }
    return parts.join('\n');
  }
}
