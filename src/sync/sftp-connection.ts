import { Client, type SFTPWrapper } from 'ssh2';
import type { ConnectionMethod, SSHConfig } from '../types/config';
import { mapSSHConnectionError } from '../ssh/ssh-client';
import type { BridgeError } from '../types/errors';
import { makeHostVerifier } from '../ssh/host-key-store';

/** Settings required to establish an SSH-backed SFTP session. */
export interface SftpConnectionOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
  connectionMethod: ConnectionMethod;
}

function sshConfig(options: SftpConnectionOptions): SSHConfig {
  return {
    host: options.host,
    port: options.port,
    username: options.username,
    password: options.password,
    timeoutMs: options.timeoutMs,
    method: options.connectionMethod,
  };
}

/** Preserve the same actionable connection errors for command SSH and SFTP. */
export function mapSftpConnectionError(
  err: Error,
  options: SftpConnectionOptions,
): BridgeError {
  return mapSSHConnectionError(err, sshConfig(options));
}

/** Connect to the tablet and open one authenticated SFTP session. */
export function connectSftp(
  options: SftpConnectionOptions,
): Promise<{ conn: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    const timeoutId = window.setTimeout(() => {
      conn.destroy();
      const error = Object.assign(
        new Error(
          `SFTP connection to ${options.host}:${options.port} timed out after ${options.timeoutMs}ms.`,
        ),
        { code: 'ETIMEDOUT', syscall: 'connect' },
      );
      reject(mapSftpConnectionError(error, options));
    }, options.timeoutMs + 1000);

    conn.on('ready', () => {
      window.clearTimeout(timeoutId);
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          reject(new Error(`Failed to open SFTP session: ${err.message}`));
          return;
        }
        resolve({ conn, sftp });
      });
    });

    conn.on('error', (err) => {
      window.clearTimeout(timeoutId);
      reject(mapSftpConnectionError(err, options));
    });

    conn.connect({
      host: options.host,
      port: options.port,
      username: options.username,
      password: options.password,
      readyTimeout: options.timeoutMs,
      hostVerifier: makeHostVerifier(options.host),
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
    });
  });
}
