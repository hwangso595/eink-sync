/** Networking helpers used by settings and tablet-side address discovery. */

const USB_TABLET_IP = '10.11.99.1';

/** True if `value` is a syntactically valid dotted-quad IPv4 address. */
export function isValidIpv4(value: string): boolean {
  const match = value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;

  return match.slice(1).every((octet) => {
    const number = Number(octet);
    return number >= 0 && number <= 255 && String(number) === octet;
  });
}

/** Convert a dotted-quad IPv4 string to a 32-bit integer (or null if invalid). */
function ipToInt(ip: string): number | null {
  if (!isValidIpv4(ip)) return null;
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

/** A non-internal IPv4 interface on this machine. */
export interface LocalInterface {
  address: string;
  netmask: string;
}

/** Whether `targetIp` shares a subnet with one of the supplied interfaces. */
export function sharesLocalSubnet(
  targetIp: string,
  interfaces: LocalInterface[],
): boolean {
  const target = ipToInt(targetIp);
  if (target === null || interfaces.length === 0) return true;

  for (const iface of interfaces) {
    const local = ipToInt(iface.address);
    const mask = ipToInt(iface.netmask);
    if (local !== null && mask !== null && (target & mask) === (local & mask)) {
      return true;
    }
  }

  return false;
}

function isUsableWifiAddress(value: string): boolean {
  if (!isValidIpv4(value)) return false;
  return value !== USB_TABLET_IP && !value.startsWith('127.') && !value.startsWith('169.254.');
}

/** Read the source address selected by the kernel's default IPv4 route. */
export function parseRouteSourceIpv4(output: string): string | null {
  const match = output.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)\b/);
  return match && isUsableWifiAddress(match[1]) ? match[1] : null;
}

/** Fallback parser for one-line or legacy multiline `ip -4 addr` output. */
export function parseGlobalIpv4(output: string): string | null {
  const matches = output.matchAll(/\binet\s+(\d+\.\d+\.\d+\.\d+)\//g);
  for (const match of matches) {
    if (isUsableWifiAddress(match[1])) return match[1];
  }
  return null;
}
