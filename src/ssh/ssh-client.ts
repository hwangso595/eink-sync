/**
 * SSH client for reMarkable tablet communication.
 *
 * Wraps the ssh2 library with reMarkable-specific connection handling,
 * structured error mapping, and automatic resource cleanup.
 *
 * Design decisions:
 * - One connection at a time (the tablet is single-user).
 * - Commands run sequentially to avoid overwhelming the rM1's single core.
 * - Timeouts are aggressive (10s default) because USB connections are local.
 * - Every SSH error is mapped to a BridgeError with a user-friendly suggestion.
 */

import { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import { SSHConfig } from '../types/config';
import { BridgeError, ErrorCode } from '../types/errors';
import { logger } from '../utils/logger';
import { makeExactHostVerifier, makeHostVerifier } from './host-key-store';

/** Result of executing a remote command. */
export interface CommandResult {
  /** Combined stdout output. */
  stdout: string;
  /** Combined stderr output. */
  stderr: string;
  /** Process exit code (0 = success). */
  exitCode: number;
}

/**
 * Interface for SSH command execution, extracted for testability.
 *
 * Any module that needs to run commands on the tablet should depend on this
 * interface rather than the concrete ReMarkableSSHClient class.
 */
export interface SSHExecutor {
  connect(): Promise<void>;
  execute(command: string, timeoutMs?: number): Promise<CommandResult>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  isConnected(): boolean;
}

/** Map a low-level ssh2 connection error to an actionable plugin error. */
export function mapSSHConnectionError(err: Error, config: SSHConfig): BridgeError {
  const msg = err.message.toLowerCase();
  const socketError = err as Error & { code?: unknown; syscall?: unknown };
  const errorCode = typeof socketError.code === 'string'
    ? socketError.code.toUpperCase()
    : '';
  const syscall = typeof socketError.syscall === 'string'
    ? socketError.syscall.toLowerCase()
    : '';

  // Server-side credential rejection is not an operating-system socket
  // policy failure, even though both may be described as "permission denied".
  if (
    msg.includes('authentication')
    || msg.includes('auth')
    || msg.includes('permission denied')
  ) {
    return new BridgeError(
      ErrorCode.SSH_AUTH_FAILED,
      'SSH authentication failed. The root password may be incorrect.',
      'Find the correct password in Settings > Help > About > Copyrights and Licenses on your reMarkable.',
      err,
    );
  }

  const socketAccessDenied = (
    (errorCode === 'EACCES' && (!syscall || syscall === 'connect'))
    || /\bconnect\s+eacces\b/i.test(err.message)
    || /access (?:a )?socket .*forbidden/i.test(err.message)
  );
  if (socketAccessDenied) {
    return new BridgeError(
      ErrorCode.SSH_SOCKET_ACCESS_DENIED,
      `SSH access to ${config.host}:${config.port} was denied before authentication (EACCES).`,
      config.method === 'usb'
        ? 'First confirm Developer Mode and USB SSH are enabled on the tablet. Enabling Developer Mode factory-resets current tablets, so back up first; a successful ping does not prove TCP 22 is available. If USB SSH is already enabled, allow Obsidian (its Electron/Node runtime) through Windows Defender Firewall, endpoint security, and VPN network-lock rules, including outbound TCP 22 to 10.11.99.1 on a Public USB network.'
        : `First enable tablet WiFi SSH by connecting over USB and running rm-ssh-over-wlan on. If WiFi SSH is already enabled, allow Obsidian (its Electron/Node runtime) through the firewall, endpoint security, and VPN network-lock rules for outbound TCP 22 to ${config.host}.`,
      err,
    );
  }

  if (msg.includes('econnrefused') || msg.includes('connection refused')) {
    return new BridgeError(
      ErrorCode.SSH_CONNECTION_REFUSED,
      `Connection refused by ${config.host}:${config.port}.`,
      config.method === 'usb'
        ? 'Ensure the tablet is powered on. Current models require Developer Mode before USB SSH; enabling it factory-resets the tablet, so back up first.'
        : 'WiFi SSH may be disabled. Connect over USB, enable Developer Mode if required (back up first; enabling it factory-resets current tablets), then run rm-ssh-over-wlan on.',
      err,
    );
  }

  if (msg.includes('etimedout') || msg.includes('timeout') || msg.includes('timed out')) {
    return new BridgeError(
      ErrorCode.SSH_TIMEOUT,
      `Connection to ${config.host} timed out.`,
      config.method === 'usb'
        ? 'Check the USB cable and Developer Mode. Enabling Developer Mode factory-resets current tablets, so back up first. The USB address is normally 10.11.99.1.'
        : 'Ensure both devices are on the same network and the tablet is awake. If needed, connect over USB and run rm-ssh-over-wlan on.',
      err,
    );
  }

  if (msg.includes('ehostunreach') || msg.includes('enetunreach') || msg.includes('unreachable')) {
    return new BridgeError(
      ErrorCode.SSH_HOST_UNREACHABLE,
      `Host ${config.host} is unreachable.`,
      config.method === 'usb'
        ? 'Reconnect the USB cable and verify Developer Mode when required. Enabling it factory-resets current tablets, so back up first.'
        : 'Check that both devices are on the same WiFi network. If needed, connect over USB and run rm-ssh-over-wlan on.',
      err,
    );
  }

  return new BridgeError(
    ErrorCode.SSH_COMMAND_FAILED,
    `SSH error: ${err.message}`,
    'Check your connection settings and try again.',
    err,
  );
}

/**
 * Manages an SSH connection to the reMarkable tablet.
 *
 * Usage:
 *   const client = new ReMarkableSSHClient(config);
 *   await client.connect();
 *   const result = await client.execute('cat /etc/version');
 *   await client.disconnect();
 */
export class ReMarkableSSHClient implements SSHExecutor {
  private client: Client | null = null;
  private connected = false;

  constructor(private readonly config: SSHConfig) {}

  /** Whether the client currently has an active connection. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Establish an SSH connection to the reMarkable.
   *
   * @throws BridgeError with appropriate code on failure.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      logger.debug('Already connected, skipping connect()');
      return;
    }

    const connectConfig: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      readyTimeout: this.config.timeoutMs,
      // Pin the tablet's host key (TOFU) so the root password is never sent to
      // a machine impersonating the tablet. See host-key-store for policy.
      hostVerifier: this.config.expectedHostKeyFingerprint
        ? makeExactHostVerifier(this.config.expectedHostKeyFingerprint)
        : makeHostVerifier(this.config.host),
      // reMarkable uses dropbear SSH which has limited algorithm support
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
        serverHostKey: [
          'ssh-ed25519',
          'ecdsa-sha2-nistp256',
          'ssh-rsa',
        ],
      },
    };

    return new Promise<void>((resolve, reject) => {
      const client = new Client();

      const timeoutId = window.setTimeout(() => {
        client.destroy();
        reject(new BridgeError(
          ErrorCode.SSH_TIMEOUT,
          `SSH connection to ${this.config.host}:${this.config.port} timed out after ${this.config.timeoutMs}ms.`,
          this.config.method === 'usb'
            ? 'Ensure the USB cable is connected and the tablet is powered on.'
            : 'Ensure both devices are on the same WiFi network and the tablet is awake.',
        ));
      }, this.config.timeoutMs + 1000);

      client.on('ready', () => {
        window.clearTimeout(timeoutId);
        this.client = client;
        this.connected = true;
        logger.info(`SSH connected to ${this.config.host}`);
        resolve();
      });

      client.on('error', (err: Error) => {
        window.clearTimeout(timeoutId);
        this.connected = false;
        reject(this.mapSSHError(err));
      });

      client.on('close', () => {
        this.connected = false;
        this.client = null;
        logger.debug('SSH connection closed');
      });

      logger.debug(`Connecting to ${this.config.host}:${this.config.port}...`);
      client.connect(connectConfig);
    });
  }

  /**
   * Execute a command on the reMarkable over SSH.
   *
   * @param command - Shell command to execute.
   * @param timeoutMs - Per-command timeout (default: 30s).
   * @returns The command's stdout, stderr, and exit code.
   * @throws BridgeError if not connected or command execution fails.
   */
  async execute(command: string, timeoutMs = 30_000): Promise<CommandResult> {
    if (!this.client || !this.connected) {
      throw new BridgeError(
        ErrorCode.SSH_COMMAND_FAILED,
        'Cannot execute command: not connected to the tablet.',
        'Call connect() before executing commands.',
      );
    }

    logger.debug(`Executing: ${command}`);

    return new Promise<CommandResult>((resolve, reject) => {
      let stream: ClientChannel | null = null;

      const timeoutId = window.setTimeout(() => {
        if (stream) {
          stream.close();
        }
        reject(new BridgeError(
          ErrorCode.SSH_COMMAND_FAILED,
          `Command timed out after ${timeoutMs}ms: ${command}`,
          'The tablet may be under heavy load. Try again in a moment.',
        ));
      }, timeoutMs);

      this.client!.exec(command, (err: Error | undefined, chan: ClientChannel) => {
        if (err) {
          window.clearTimeout(timeoutId);
          reject(new BridgeError(
            ErrorCode.SSH_COMMAND_FAILED,
            `Failed to execute command: ${err.message}`,
            undefined,
            err,
          ));
          return;
        }

        stream = chan;
        let stdout = '';
        let stderr = '';

        chan.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        chan.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        chan.on('close', (code: number | null) => {
          window.clearTimeout(timeoutId);
          const result: CommandResult = {
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exitCode: code ?? -1,
          };
          logger.debug(`Command exit code: ${result.exitCode}`);
          resolve(result);
        });
      });
    });
  }

  /**
   * Disconnect from the tablet, releasing all resources.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.end();
      this.client = null;
      this.connected = false;
      logger.info('SSH disconnected');
    }
  }

  /**
   * Test connectivity with a simple echo command.
   *
   * @returns true if the device responds correctly.
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.execute('echo ok', 5000);
      return result.exitCode === 0 && result.stdout.trim() === 'ok';
    } catch {
      return false;
    }
  }

  /**
   * Map low-level ssh2 errors to user-friendly BridgeErrors.
   */
  private mapSSHError(err: Error): BridgeError {
    return mapSSHConnectionError(err, this.config);
  }
}
