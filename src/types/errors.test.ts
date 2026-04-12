import { BridgeError, ErrorCode } from './errors';

describe('BridgeError', () => {
  it('stores code and message', () => {
    const err = new BridgeError(ErrorCode.SSH_TIMEOUT, 'Connection timed out');
    expect(err.code).toBe(ErrorCode.SSH_TIMEOUT);
    expect(err.message).toBe('Connection timed out');
    expect(err.name).toBe('BridgeError');
  });

  it('stores suggestion', () => {
    const err = new BridgeError(
      ErrorCode.SSH_AUTH_FAILED,
      'Auth failed',
      'Check password',
    );
    expect(err.suggestion).toBe('Check password');
  });

  it('stores cause error', () => {
    const cause = new Error('original');
    const err = new BridgeError(
      ErrorCode.SSH_COMMAND_FAILED,
      'Command failed',
      undefined,
      cause,
    );
    expect(err.cause).toBe(cause);
  });

  it('formats user message without suggestion', () => {
    const err = new BridgeError(ErrorCode.SSH_TIMEOUT, 'Timed out');
    expect(err.toUserMessage()).toBe('Timed out');
  });

  it('formats user message with suggestion', () => {
    const err = new BridgeError(
      ErrorCode.SSH_TIMEOUT,
      'Timed out',
      'Check cable',
    );
    expect(err.toUserMessage()).toBe('Timed out\nSuggestion: Check cable');
  });

  it('is an instance of Error', () => {
    const err = new BridgeError(ErrorCode.SSH_TIMEOUT, 'test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BridgeError);
  });
});
