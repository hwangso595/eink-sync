/**
 * Connection configuration types for the reMarkable-Obsidian bridge.
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

/** Sensible defaults for a fresh installation. */
export const DEFAULT_SSH_CONFIG: SSHConfig = {
  host: '10.11.99.1',
  port: 22,
  username: 'root',
  password: '',
  timeoutMs: 10_000,
  method: 'usb',
};
