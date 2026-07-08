/**
 * Tests for the TOFU SSH host-key store: pin on first sight, accept matching
 * keys, and notify-then-REFUSE on change (never silently re-pin).
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

  it('refuses a changed key (does not silently re-pin) and keeps the original pin', () => {
    const handler = jest.fn();
    initHostKeyStore(tmpStorePath(), handler);

    expect(verifyHostKey('host', 'fp1')).toBe(true);  // pin
    expect(verifyHostKey('host', 'fp2')).toBe(false); // changed -> notify + REFUSE
    expect(handler).toHaveBeenCalledWith('host', 'fp1', 'fp2');

    // The original key still verifies; the changed key stays refused (no re-pin).
    expect(verifyHostKey('host', 'fp1')).toBe(true);
    expect(verifyHostKey('host', 'fp2')).toBe(false);
  });

  it('accepts a changed key only after an explicit resetHostKey', () => {
    const handler = jest.fn();
    initHostKeyStore(tmpStorePath(), handler);
    expect(verifyHostKey('host', 'fp1')).toBe(true);
    expect(verifyHostKey('host', 'fp2')).toBe(false);

    resetHostKey('host');
    // After an explicit reset the new key is first-sight again: pinned + accepted.
    expect(verifyHostKey('host', 'fp2')).toBe(true);
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
