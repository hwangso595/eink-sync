import { ErrorCode } from '../types/errors';
import { mapSftpConnectionError, type SftpConnectionOptions } from './sftp-connection';

function options(connectionMethod: 'usb' | 'wifi'): SftpConnectionOptions {
  return {
    host: connectionMethod === 'usb' ? '10.11.99.1' : '192.168.1.42',
    port: 22,
    username: 'root',
    password: 'secret',
    timeoutMs: 10_000,
    connectionMethod,
  };
}

describe('mapSftpConnectionError', () => {
  it('maps an OS-level USB EACCES with USB-specific recovery guidance', () => {
    const error = Object.assign(new Error('connect EACCES 10.11.99.1:22'), {
      code: 'EACCES',
      syscall: 'connect',
    });

    const result = mapSftpConnectionError(error, options('usb'));

    expect(result.code).toBe(ErrorCode.SSH_SOCKET_ACCESS_DENIED);
    expect(result.suggestion).toContain('Developer Mode');
    expect(result.suggestion).toContain('outbound TCP 22 to 10.11.99.1');
  });

  it('maps WiFi EACCES with WiFi SSH guidance', () => {
    const error = Object.assign(new Error('connect EACCES 192.168.1.42:22'), {
      code: 'EACCES',
      syscall: 'connect',
    });

    const result = mapSftpConnectionError(error, options('wifi'));

    expect(result.code).toBe(ErrorCode.SSH_SOCKET_ACCESS_DENIED);
    expect(result.suggestion).toContain('rm-ssh-over-wlan on');
  });

  it('does not misclassify SSH authentication rejection as socket EACCES', () => {
    const error = Object.assign(new Error('All configured authentication methods failed'), {
      code: 'EACCES',
    });

    const result = mapSftpConnectionError(error, options('usb'));

    expect(result.code).toBe(ErrorCode.SSH_AUTH_FAILED);
  });
});
