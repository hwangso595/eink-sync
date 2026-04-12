/**
 * Configuration types for the reMarkable-Obsidian bridge.
 *
 * The config file lives in the Obsidian vault at .remarkable-bridge/config.json
 * for portability, as specified in the product spec.
 */

/** How the user connects to the reMarkable. */
export type ConnectionMethod = 'usb' | 'wifi';

/** SSH connection settings for the reMarkable tablet. */
export interface SSHConfig {
  /** Tablet IP address. USB default: 10.11.99.1 */
  host: string;
  /** SSH port, always 22 on stock firmware. */
  port: number;
  /** SSH username, always "root" on reMarkable. */
  username: string;
  /** Root password from Settings > Help > About > Copyrights. */
  password: string;
  /** Connection timeout in milliseconds. */
  timeoutMs: number;
  /** Preferred connection method. */
  method: ConnectionMethod;
}

/** Full bridge configuration. */
export interface BridgeConfig {
  ssh: SSHConfig;
  /** Path within the vault for extraction output. */
  outputFolder: string;
  /** Path to the synced xochitl directory on the host. */
  syncFolder: string;
  /** Highlight template file path (relative to vault). */
  templatePath: string | null;
  /** Timestamp of last successful sync. */
  lastSyncTimestamp: number | null;
}

/** Sensible defaults for a fresh installation. */
export const DEFAULT_SSH_CONFIG: SSHConfig = {
  host: '10.11.99.1',
  port: 22,
  username: 'root',
  password: '',
  timeoutMs: 10_000,
  method: 'usb',
};

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  ssh: DEFAULT_SSH_CONFIG,
  outputFolder: 'ReMarkable',
  syncFolder: '',
  templatePath: null,
  lastSyncTimestamp: null,
};
