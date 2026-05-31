/**
 * Tests for net-utils.ts -- IPv4 validation and subnet comparison used by the
 * settings UI to catch the "saved tablet IP is on a different network" trap.
 */

import { isValidIpv4, sharesLocalSubnet, type LocalInterface } from './net-utils';

describe('isValidIpv4', () => {
  it('accepts well-formed dotted quads', () => {
    expect(isValidIpv4('10.0.0.41')).toBe(true);
    expect(isValidIpv4('192.168.2.151')).toBe(true);
    expect(isValidIpv4('0.0.0.0')).toBe(true);
    expect(isValidIpv4('255.255.255.255')).toBe(true);
  });

  it('rejects malformed or out-of-range input', () => {
    expect(isValidIpv4('')).toBe(false);
    expect(isValidIpv4('10.0.0')).toBe(false);
    expect(isValidIpv4('10.0.0.256')).toBe(false);
    expect(isValidIpv4('10.0.0.01')).toBe(false); // leading zero
    expect(isValidIpv4('remarkable.local')).toBe(false);
    expect(isValidIpv4('10.0.0.41 ')).toBe(true); // trimmed
  });
});

describe('sharesLocalSubnet', () => {
  const locals: LocalInterface[] = [
    { address: '192.168.2.151', netmask: '255.255.255.0' },
  ];

  it('returns true when the target is on the same /24', () => {
    expect(sharesLocalSubnet('192.168.2.41', locals)).toBe(true);
  });

  it('returns false when the target is on a different subnet (the bug we hit)', () => {
    expect(sharesLocalSubnet('10.0.0.41', locals)).toBe(false);
  });

  it('does not claim a mismatch when there are no interfaces to compare', () => {
    expect(sharesLocalSubnet('10.0.0.41', [])).toBe(true);
  });

  it('does not flag invalid IPs (validation is a separate concern)', () => {
    expect(sharesLocalSubnet('not-an-ip', locals)).toBe(true);
  });
});
