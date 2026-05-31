/**
 * Tests for the TOFU SSH host-key store: pin on first sight, accept matching
 * keys, and notify-then-repin on change.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initHostKeyStore,
  verifyHostKey,
  fingerprintFromKey,
  resetHostKey,
  makeHostVerifier,
  _resetStoreForTests,
} from './host-key-store';

function tmpStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkey-test-'));
  return path.join(dir, 'known-hosts.json');
}

describe('host-key-store', () => {
  afterEach(() => _resetStoreForTests());

  it('pins a host key on first sight and accepts it thereafter', () => {
    initHostKeyStore(tmpStorePath());
    expect(verifyHostKey('10.0.0.41', 'aaaa')).toBe(true);
    expect(verifyHostKey('10.0.0.41', 'aaaa')).toBe(true);
  });

  it('notifies once on a changed key, then re-pins to the new key', () => {
    const handler = jest.fn();
    initHostKeyStore(tmpStorePath(), handler);

    expect(verifyHostKey('host', 'fp1')).toBe(true); // pin
    expect(verifyHostKey('host', 'fp2')).toBe(true); // changed -> notify + repin
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('host', 'fp1', 'fp2');

    // Re-pinned: the new key now verifies without further notifications.
    expect(verifyHostKey('host', 'fp2')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('tracks hosts independently', () => {
    initHostKeyStore(tmpStorePath());
    expect(verifyHostKey('a', 'k1')).toBe(true);
    expect(verifyHostKey('b', 'k2')).toBe(true);
    expect(verifyHostKey('a', 'k1')).toBe(true);
    expect(verifyHostKey('b', 'k2')).toBe(true);
  });

  it('persists pins across re-initialisation from the same file', () => {
    const storePath = tmpStorePath();
    initHostKeyStore(storePath);
    verifyHostKey('host', 'fp1');

    // Reload from disk with a fresh handler — the pin should survive.
    const handler = jest.fn();
    initHostKeyStore(storePath, handler);
    verifyHostKey('host', 'fp1');
    expect(handler).not.toHaveBeenCalled();
  });

  it('resetHostKey forces a re-pin', () => {
    initHostKeyStore(tmpStorePath());
    verifyHostKey('host', 'fp1');
    resetHostKey('host');
    // After reset the next key is treated as first-sight (pinned, accepted).
    expect(verifyHostKey('host', 'fp-new')).toBe(true);
  });

  it('fingerprintFromKey is stable and key-dependent', () => {
    const a = fingerprintFromKey(Buffer.from('key-material'));
    const b = fingerprintFromKey(Buffer.from('key-material'));
    const c = fingerprintFromKey(Buffer.from('other'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('makeHostVerifier hashes the key and pins per host', () => {
    initHostKeyStore(tmpStorePath());
    const verify = makeHostVerifier('10.0.0.41');
    expect(verify(Buffer.from('rm-key'))).toBe(true);
    expect(verify(Buffer.from('rm-key'))).toBe(true);
  });
});
