/**
 * Small networking helpers for the settings UI.
 *
 * Used to catch the most common sync-breaking mistake: a saved tablet IP that
 * is no longer on the same network as this computer (e.g. after switching
 * Wi-Fi). All local-only; no network calls.
 */

import * as os from 'os';

/** True if `value` is a syntactically valid dotted-quad IPv4 address. */
export function isValidIpv4(value: string): boolean {
  const m = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((oct) => {
    const n = Number(oct);
    // Reject out-of-range and non-canonical octets (e.g. leading zeros like
    // "01"): the canonical decimal string must round-trip exactly.
    return n >= 0 && n <= 255 && String(n) === oct;
  });
}

/** Convert a dotted-quad IPv4 string to a 32-bit integer (or null if invalid). */
function ipToInt(ip: string): number | null {
  if (!isValidIpv4(ip)) return null;
  return ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

/** A non-internal IPv4 interface on this machine. */
export interface LocalInterface {
  address: string;
  netmask: string;
}

/** Enumerate this machine's non-internal IPv4 interfaces. */
export function localIpv4Interfaces(): LocalInterface[] {
  const result: LocalInterface[] = [];
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      // Node <18 exposes `family` as 'IPv4'; newer as 4. Accept both.
      const isV4 = a.family === 'IPv4' || (a.family as unknown as number) === 4;
      if (isV4 && !a.internal) {
        result.push({ address: a.address, netmask: a.netmask });
      }
    }
  }
  return result;
}

/**
 * Whether `targetIp` plausibly shares a subnet with any local interface,
 * using each interface's own netmask. Returns true when there are no local
 * interfaces to compare against (can't claim a mismatch we can't see).
 */
export function sharesLocalSubnet(
  targetIp: string,
  interfaces: LocalInterface[] = localIpv4Interfaces(),
): boolean {
  const target = ipToInt(targetIp);
  if (target === null) return true; // not our job to flag invalid here
  if (interfaces.length === 0) return true;

  for (const iface of interfaces) {
    const local = ipToInt(iface.address);
    const mask = ipToInt(iface.netmask);
    if (local === null || mask === null) continue;
    if ((target & mask) === (local & mask)) return true;
  }
  return false;
}
