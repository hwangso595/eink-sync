import {
  parseFirmwareVersion,
  compareFirmwareVersions,
  getInstallationPath,
  usesV6FileFormat,
  getFirmwareCompatibilityWarning,
} from './firmware';
import { BridgeError, ErrorCode } from '../types/errors';

describe('parseFirmwareVersion', () => {
  it('parses a standard firmware version string', () => {
    const v = parseFirmwareVersion('3.26.0.68');
    expect(v.raw).toBe('3.26.0.68');
    expect(v.major).toBe(3);
    expect(v.minor).toBe(26);
    expect(v.patch).toBe(0);
    expect(v.build).toBe(68);
  });

  it('trims whitespace and newlines', () => {
    const v = parseFirmwareVersion('  3.0.0.1\n');
    expect(v.raw).toBe('3.0.0.1');
    expect(v.major).toBe(3);
  });

  it('throws BridgeError on invalid format', () => {
    expect(() => parseFirmwareVersion('3.26')).toThrow(BridgeError);
    expect(() => parseFirmwareVersion('not-a-version')).toThrow(BridgeError);
    expect(() => parseFirmwareVersion('')).toThrow(BridgeError);
  });

  it('throws with FIRMWARE_PARSE_FAILED code', () => {
    try {
      parseFirmwareVersion('invalid');
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe(ErrorCode.FIRMWARE_PARSE_FAILED);
    }
  });
});

describe('compareFirmwareVersions', () => {
  const v = (s: string) => parseFirmwareVersion(s);

  it('returns 0 for equal versions', () => {
    expect(compareFirmwareVersions(v('3.26.0.68'), v('3.26.0.68'))).toBe(0);
  });

  it('compares major versions', () => {
    expect(compareFirmwareVersions(v('3.0.0.0'), v('2.0.0.0'))).toBeGreaterThan(0);
    expect(compareFirmwareVersions(v('2.0.0.0'), v('3.0.0.0'))).toBeLessThan(0);
  });

  it('compares minor versions when major is equal', () => {
    expect(compareFirmwareVersions(v('3.26.0.0'), v('3.3.0.0'))).toBeGreaterThan(0);
  });

  it('compares patch versions', () => {
    expect(compareFirmwareVersions(v('3.3.2.0'), v('3.3.1.0'))).toBeGreaterThan(0);
  });

  it('compares build numbers', () => {
    expect(compareFirmwareVersions(v('3.3.2.100'), v('3.3.2.50'))).toBeGreaterThan(0);
  });
});

describe('getInstallationPath', () => {
  const v = (s: string) => parseFirmwareVersion(s);

  it('returns toltec for firmware 2.6 to 3.3', () => {
    expect(getInstallationPath(v('2.6.0.0'))).toBe('toltec');
    expect(getInstallationPath(v('3.3.2.1666'))).toBe('toltec');
  });

  it('returns entware for firmware 3.4+', () => {
    expect(getInstallationPath(v('3.4.0.0'))).toBe('entware');
    expect(getInstallationPath(v('3.26.0.68'))).toBe('entware');
  });

  it('throws for firmware below 2.6', () => {
    expect(() => getInstallationPath(v('2.5.0.0'))).toThrow(BridgeError);
    expect(() => getInstallationPath(v('1.0.0.0'))).toThrow(BridgeError);
  });
});

describe('usesV6FileFormat', () => {
  const v = (s: string) => parseFirmwareVersion(s);

  it('returns true for firmware 3.0+', () => {
    expect(usesV6FileFormat(v('3.0.0.0'))).toBe(true);
    expect(usesV6FileFormat(v('3.26.0.68'))).toBe(true);
  });

  it('returns false for firmware below 3.0', () => {
    expect(usesV6FileFormat(v('2.15.0.0'))).toBe(false);
    expect(usesV6FileFormat(v('2.6.0.0'))).toBe(false);
  });
});

describe('getFirmwareCompatibilityWarning', () => {
  const v = (s: string) => parseFirmwareVersion(s);

  it('returns null for known-good firmware', () => {
    expect(getFirmwareCompatibilityWarning(v('3.26.0.68'))).toBeNull();
    expect(getFirmwareCompatibilityWarning(v('3.0.0.0'))).toBeNull();
  });

  it('returns a warning for newer untested firmware', () => {
    const warning = getFirmwareCompatibilityWarning(v('3.28.0.0'));
    expect(warning).not.toBeNull();
    expect(warning).toContain('newer');
  });

  it('returns a warning for very old firmware', () => {
    const warning = getFirmwareCompatibilityWarning(v('2.6.0.0'));
    expect(warning).not.toBeNull();
    expect(warning).toContain('older');
  });
});
