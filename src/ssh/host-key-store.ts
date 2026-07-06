/**
 * Trust-on-first-use (TOFU) store for the tablet's SSH host key.
 *
 * The plugin authenticates to the tablet with the root *password*. Without host
 * key verification, ssh2 accepts whatever key any host at the configured
 * address presents — so a machine impersonating the tablet on the LAN could
 * capture that password. This module pins the tablet's host key on first
 * connect and detects later changes.
 *
 * Policy: pin-and-notify. On first sight we record the key. On a change we fire
 * a one-time notification (so a real MITM is visible to the user) and then
 * re-pin to the new key. We deliberately do NOT hard-reject a changed key:
 * locking the user out of their own tablet (e.g. after a legitimate firmware
 * reflash regenerates the key) would violate the project's "never break the
 * tablet workflow" rule. Detection-with-notification is the chosen balance.
 *
 * Storage is a small JSON file in the plugin directory; no network calls.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import { logger } from '../utils/logger';

/** Callback invoked when a host's key changes from the pinned value. */
export type HostKeyMismatchHandler = (
  host: string,
  oldFingerprint: string,
  newFingerprint: string,
) => void;

let storePath: string | null = null;
let fingerprints: Record<string, string> = {};
let mismatchHandler: HostKeyMismatchHandler | null = null;

/** sha256 hex fingerprint of a raw host key buffer. */
export function fingerprintFromKey(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Initialise the store from a JSON file and register the mismatch handler.
 * Safe to call multiple times (e.g. on settings reload).
 */
export function initHostKeyStore(filePath: string, onMismatch?: HostKeyMismatchHandler): void {
  storePath = filePath;
  mismatchHandler = onMismatch ?? null;
  // Start fresh so deleting known-hosts.json actually clears pins on re-init
  // (e.g. after a legitimate host-key change), rather than keeping stale ones.
  fingerprints = {};
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fingerprints = parsed && typeof parsed === 'object' ? parsed : {};
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not load known-hosts store: ${msg}`);
    fingerprints = {};
  }
}

function persist(): void {
  if (!storePath) return;
  try {
    fs.writeFileSync(storePath, JSON.stringify(fingerprints, null, 2), 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not persist known-hosts store: ${msg}`);
  }
}

/**
 * Verify a presented host key for `host`. Returns true if the connection
 * should proceed (always true under the pin-and-notify policy), recording or
 * updating the pin as a side effect.
 *
 * @param host - The host being connected to (keyed independently).
 * @param keyHash - sha256 fingerprint of the presented key.
 */
export function verifyHostKey(host: string, keyHash: string): boolean {
  const known = fingerprints[host];

  if (!known) {
    // First time we've seen this host: pin it.
    fingerprints[host] = keyHash;
    persist();
    logger.info(`Pinned SSH host key for ${host} (${keyHash.slice(0, 16)}…)`);
    return true;
  }

  if (known === keyHash) {
    return true;
  }

  // Key changed since we pinned it: refuse (possible MITM) rather than send
  // credentials. Keep the original pin; a legit change (reflash) must be
  // re-trusted via resetHostKey. Never silently re-pin.
  logger.warn(
    `SSH host key for ${host} changed (was ${known.slice(0, 16)}…, now ${keyHash.slice(0, 16)}…). ` +
    `Refusing the connection. If you reflashed the tablet, remove the pinned key to re-trust it.`,
  );
  if (mismatchHandler) {
    try {
      mismatchHandler(host, known, keyHash);
    } catch {
      /* handler errors are non-fatal */
    }
  }
  return false;
}

/** Build an ssh2 `hostVerifier` callback bound to a specific host. */
export function makeHostVerifier(host: string): (key: Buffer) => boolean {
  return (key: Buffer) => verifyHostKey(host, fingerprintFromKey(key));
}

/** Remove the pinned key for a host (forces re-pin on next connect). Test/maintenance use. */
export function resetHostKey(host: string): void {
  delete fingerprints[host];
  persist();
}

/** Clear all in-memory state. Test-only. */
export function _resetStoreForTests(): void {
  storePath = null;
  fingerprints = {};
  mismatchHandler = null;
}
