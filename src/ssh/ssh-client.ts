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
import { makeHostVerifier } from './host-key-store';

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
      hostVerifier: makeHostVerifier(this.config.host),
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

      const timeoutId = setTimeout(() => {
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
        clearTimeout(timeoutId);
        this.client = client;
        this.connected = true;
        logger.info(`SSH connected to ${this.config.host}`);
        resolve();
      });

      client.on('error', (err: Error) => {
        clearTimeout(timeoutId);
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

      const timeoutId = setTimeout(() => {
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
          clearTimeout(timeoutId);
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
          clearTimeout(timeoutId);
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
    const msg = err.message.toLowerCase();

    if (msg.includes('authentication') || msg.includes('auth')) {
      return new BridgeError(
        ErrorCode.SSH_AUTH_FAILED,
        'SSH authentication failed. The root password may be incorrect.',
        'Find the correct password in Settings > Help > About > Copyrights and Licenses on your reMarkable.',
        err,
      );
    }

    if (msg.includes('econnrefused') || msg.includes('connection refused')) {
      return new BridgeError(
        ErrorCode.SSH_CONNECTION_REFUSED,
        `Connection refused by ${this.config.host}:${this.config.port}.`,
        'Ensure the tablet is powered on and SSH is enabled (it is by default on reMarkable).',
        err,
      );
    }

    if (msg.includes('etimedout') || msg.includes('timeout') || msg.includes('timed out')) {
      return new BridgeError(
        ErrorCode.SSH_TIMEOUT,
        `Connection to ${this.config.host} timed out.`,
        this.config.method === 'usb'
          ? 'Check the USB cable connection. The tablet should show 10.11.99.1 in Settings > Help > About.'
          : 'Ensure both devices are on the same network and the tablet is not in sleep mode.',
        err,
      );
    }

    if (msg.includes('ehostunreach') || msg.includes('enetunreach') || msg.includes('unreachable')) {
      return new BridgeError(
        ErrorCode.SSH_HOST_UNREACHABLE,
        `Host ${this.config.host} is unreachable.`,
        this.config.method === 'usb'
          ? 'Reconnect the USB cable and ensure the tablet is powered on.'
          : 'Check that both devices are on the same WiFi network.',
        err,
      );
    }

    // Fallback for unexpected errors
    return new BridgeError(
      ErrorCode.SSH_COMMAND_FAILED,
      `SSH error: ${err.message}`,
      'Check your connection settings and try again.',
      err,
    );
  }
}
