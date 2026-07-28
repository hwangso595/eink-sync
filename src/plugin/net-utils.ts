/**
 * Small networking helpers for the settings UI.
 *
 * Pure IPv4 validation and comparison helpers. Callers provide any interface
 * data explicitly; the plugin does not enumerate host network interfaces.
 */

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

/**
 * Whether `targetIp` shares a subnet with one of the explicitly supplied
 * interfaces. Returns true when there are none to compare against.
 */
export function sharesLocalSubnet(
  targetIp: string,
  interfaces: LocalInterface[],
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
