/**
 * Tests for bidirectional sync configuration and validation.
 */

import {
  validateBidirectionalConfig,
  DEFAULT_BIDIRECTIONAL_CONFIG,
  BIDIRECTIONAL_SYNC_WARNING,
  type BidirectionalSyncConfig,
} from './bidirectional-sync';

describe('DEFAULT_BIDIRECTIONAL_CONFIG', () => {
  it('is disabled by default', () => {
    expect(DEFAULT_BIDIRECTIONAL_CONFIG.enabled).toBe(false);
  });

  it('has unacknowledged warning by default', () => {
    expect(DEFAULT_BIDIRECTIONAL_CONFIG.warningAcknowledged).toBe(false);
  });

  it('has no acknowledgement timestamp', () => {
    expect(DEFAULT_BIDIRECTIONAL_CONFIG.acknowledgedAt).toBeNull();
  });
});

describe('validateBidirectionalConfig', () => {
  it('returns null for disabled config', () => {
    const result = validateBidirectionalConfig(DEFAULT_BIDIRECTIONAL_CONFIG);
    expect(result).toBeNull();
  });

  it('returns null for properly acknowledged and enabled config', () => {
    const config: BidirectionalSyncConfig = {
      enabled: true,
      warningAcknowledged: true,
      acknowledgedAt: Date.now(),
    };
    expect(validateBidirectionalConfig(config)).toBeNull();
  });

  it('returns error when enabled without acknowledgement', () => {
    const config: BidirectionalSyncConfig = {
      enabled: true,
      warningAcknowledged: false,
      acknowledgedAt: null,
    };
    const result = validateBidirectionalConfig(config);
    expect(result).not.toBeNull();
    expect(result).toContain('acknowledging the safety warning');
  });
});

describe('BIDIRECTIONAL_SYNC_WARNING', () => {
  it('mentions xochitl restart requirement', () => {
    expect(BIDIRECTIONAL_SYNC_WARNING).toContain('xochitl restart');
  });

  it('mentions backup recommendation', () => {
    expect(BIDIRECTIONAL_SYNC_WARNING).toContain('backup');
  });

  it('mentions SSH access', () => {
    expect(BIDIRECTIONAL_SYNC_WARNING).toContain('SSH');
  });
});
