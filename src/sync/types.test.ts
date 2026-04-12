import { createDefaultSyncConfig, XOCHITL_SYNC_PATH } from './types';
import { DEFAULT_RESOURCE_BUDGETS } from '../types/device';

describe('createDefaultSyncConfig', () => {
  it('creates config with correct defaults for rM1', () => {
    const budget = DEFAULT_RESOURCE_BUDGETS.reMarkable1;
    const config = createDefaultSyncConfig('reMarkable1', budget, '/home/user/sync');

    expect(config.method).toBe('syncthing');
    expect(config.tabletSyncPath).toBe(XOCHITL_SYNC_PATH);
    expect(config.hostSyncPath).toBe('/home/user/sync');
    expect(config.schedule.enabled).toBe(true);
    expect(config.schedule.intervalMinutes).toBe(5);
    expect(config.schedule.wifiOnly).toBe(false);
    expect(config.syncthing).toBeNull();
    expect(config.deviceModel).toBe('reMarkable1');
    expect(config.resourceBudget.syncthingMaxMemoryMB).toBe(64);
    expect(config.resourceBudget.minFreeMemoryMB).toBe(100);
  });

  it('creates config with correct defaults for rM2', () => {
    const budget = DEFAULT_RESOURCE_BUDGETS.reMarkable2;
    const config = createDefaultSyncConfig('reMarkable2', budget, '/data/remarkable');

    expect(config.deviceModel).toBe('reMarkable2');
    expect(config.resourceBudget.syncthingMaxMemoryMB).toBe(128);
    expect(config.resourceBudget.minFreeMemoryMB).toBe(200);
    expect(config.hostSyncPath).toBe('/data/remarkable');
  });

  it('creates config for unknown device with conservative limits', () => {
    const budget = DEFAULT_RESOURCE_BUDGETS.unknown;
    const config = createDefaultSyncConfig('unknown', budget, '/tmp/sync');

    expect(config.resourceBudget.syncthingMaxMemoryMB).toBe(64);
    expect(config.resourceBudget.minFreeMemoryMB).toBe(100);
  });
});
