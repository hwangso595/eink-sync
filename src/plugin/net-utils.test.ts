import {
  isValidIpv4,
  parseGlobalIpv4,
  parseRouteSourceIpv4,
  sharesLocalSubnet,
  type LocalInterface,
} from './net-utils';

describe('isValidIpv4', () => {
  it('accepts well-formed dotted quads', () => {
    expect(isValidIpv4('10.0.0.41')).toBe(true);
    expect(isValidIpv4('192.168.2.151')).toBe(true);
    expect(isValidIpv4('0.0.0.0')).toBe(true);
    expect(isValidIpv4('255.255.255.255')).toBe(true);
  });

  it('rejects malformed or non-canonical addresses', () => {
    expect(isValidIpv4('')).toBe(false);
    expect(isValidIpv4('10.0.0')).toBe(false);
    expect(isValidIpv4('10.0.0.256')).toBe(false);
    expect(isValidIpv4('10.0.0.01')).toBe(false);
    expect(isValidIpv4('remarkable.local')).toBe(false);
    expect(isValidIpv4('10.0.0.41 ')).toBe(true);
  });
});

describe('sharesLocalSubnet', () => {
  const interfaces: LocalInterface[] = [
    { address: '192.168.2.151', netmask: '255.255.255.0' },
  ];

  it('compares addresses using the supplied netmask', () => {
    expect(sharesLocalSubnet('192.168.2.41', interfaces)).toBe(true);
    expect(sharesLocalSubnet('10.0.0.41', interfaces)).toBe(false);
  });

  it('does not claim a mismatch without usable comparison data', () => {
    expect(sharesLocalSubnet('10.0.0.41', [])).toBe(true);
    expect(sharesLocalSubnet('not-an-ip', interfaces)).toBe(true);
  });
});

describe('parseRouteSourceIpv4', () => {
  it.each(['wlan0', 'mlan0', 'wlp1s0'])('does not depend on interface name %s', (iface) => {
    expect(parseRouteSourceIpv4(`1.1.1.1 via 192.168.1.1 dev ${iface} src 192.168.1.42 uid 0`))
      .toBe('192.168.1.42');
  });

  it('rejects the USB gadget address', () => {
    expect(parseRouteSourceIpv4('1.1.1.1 dev usb0 src 10.11.99.1')).toBeNull();
  });

  it('rejects malformed and non-canonical source addresses', () => {
    expect(parseRouteSourceIpv4('1.1.1.1 dev wlan0 src 999.1.1.1')).toBeNull();
    expect(parseRouteSourceIpv4('1.1.1.1 dev wlan0 src 192.168.001.2')).toBeNull();
  });

  it('accepts route details split across lines', () => {
    expect(parseRouteSourceIpv4('1.1.1.1 via 192.168.1.1 dev wlan0\n    src 192.168.1.42'))
      .toBe('192.168.1.42');
  });
});

describe('parseGlobalIpv4', () => {
  it('skips USB and returns another global interface', () => {
    const output = [
      '2: usb0    inet 10.11.99.1/29 scope global usb0',
      '3: mlan0   inet 192.168.50.12/24 brd 192.168.50.255 scope global mlan0',
    ].join('\n');
    expect(parseGlobalIpv4(output)).toBe('192.168.50.12');
  });

  it('accepts legacy multiline ip output', () => {
    const output = [
      '3: wlan0: <BROADCAST,MULTICAST,UP> mtu 1500',
      '    inet 192.168.50.12/24 brd 192.168.50.255 scope global wlan0',
      '       valid_lft forever preferred_lft forever',
    ].join('\n');
    expect(parseGlobalIpv4(output)).toBe('192.168.50.12');
  });

  it('returns null for malformed, loopback, and link-local addresses', () => {
    expect(parseGlobalIpv4('1: lo inet 127.0.0.1/8\n2: eth0 inet 169.254.1.2/16')).toBeNull();
  });
});
