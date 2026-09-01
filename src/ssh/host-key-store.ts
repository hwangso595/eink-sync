/**
 * Trust-on-first-use (TOFU) store for the tablet's SSH host key.
 *
 * The plugin authenticates to the tablet with the root *password*. Without host
 * key verification, ssh2 accepts whatever key any host at the configured
 * address presents; so a machine impersonating the tablet on the LAN could
 * capture that password. This module pins the tablet's host key on first
 * connect and detects later changes.
 *
 * Policy: pin and reject mismatches. On first sight we record the key. On a
 * change we notify the user and refuse before password authentication. A
 * legitimate reflash must be explicitly re-trusted by clearing that host pin.
 *
 * Storage is a small JSON file in the plugin directory; no network calls.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { parseJson, stringRecord } from '../utils/json';

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
      const parsed = parseJson(fs.readFileSync(filePath, 'utf-8'));
      fingerprints = stringRecord(parsed);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not load known-hosts store: ${msg}`);
    fingerprints = {};
  }
}

function persist(): boolean {
  if (!storePath) return true;
  try {
    fs.writeFileSync(storePath, JSON.stringify(fingerprints, null, 2), 'utf-8');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Could not persist known-hosts store: ${msg}`);
    return false;
  }
}

/**
 * Verify a presented host key for `host`. A first-seen key proceeds only if its
 * pin can be retained; changed keys are rejected before credentials are sent.
 *
 * @param host - The host being connected to (keyed independently).
 * @param keyHash - sha256 fingerprint of the presented key.
 */
export function verifyHostKey(host: string, keyHash: string): boolean {
  const known = fingerprints[host];

  if (!known) {
    // First time we've seen this host: pin it.
    fingerprints[host] = keyHash;
    if (!persist()) {
      delete fingerprints[host];
      return false;
    }
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

/** Build a verifier that accepts only one already-authenticated host key. */
export function makeExactHostVerifier(
  expectedFingerprint: string,
): (key: Buffer) => boolean {
  return (key: Buffer) => fingerprintFromKey(key) === expectedFingerprint;
}

/** Return the currently pinned fingerprint for a host, if one has been seen. */
export function getPinnedHostFingerprint(host: string): string | null {
  return fingerprints[host] ?? null;
}

/**
 * Remember that a newly verified address is an alias for an already trusted
 * host. Callers must first connect to the alias using the source fingerprint
 * as an exact verifier; this function deliberately performs no network I/O.
 */
export function rememberVerifiedHostAlias(
  trustedHost: string,
  verifiedAlias: string,
): boolean {
  const fingerprint = fingerprints[trustedHost];
  if (!fingerprint) return false;
  const previous = fingerprints[verifiedAlias];
  fingerprints[verifiedAlias] = fingerprint;
  if (!persist()) {
    if (previous === undefined) {
      delete fingerprints[verifiedAlias];
    } else {
      fingerprints[verifiedAlias] = previous;
    }
    return false;
  }
  return true;
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
