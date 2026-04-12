import {
  generateSyncthingConfig,
  generateApiKey,
  isValidDeviceId,
} from './syncthing-config';
import type { SyncConfig, SyncthingConfig } from './types';
import { DEFAULT_RESOURCE_BUDGETS } from '../types/device';

function createTestSyncConfig(overrides?: Partial<SyncConfig>): SyncConfig {
  return {
    method: 'syncthing',
    tabletSyncPath: '/home/root/.local/share/remarkable/xochitl',
    hostSyncPath: '/home/user/remarkable-sync',
    schedule: { enabled: true, intervalMinutes: 5, wifiOnly: false },
    syncthing: null,
    deviceModel: 'reMarkable1',
    resourceBudget: DEFAULT_RESOURCE_BUDGETS.reMarkable1,
    ...overrides,
  };
}

function createTestSyncthingConfig(overrides?: Partial<SyncthingConfig>): SyncthingConfig {
  return {
    tabletDeviceId: 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH',
    hostDeviceId: 'IIIIIII-JJJJJJJ-KKKKKKK-LLLLLLL-MMMMMMM-NNNNNNN-OOOOOOO-PPPPPPP',
    tabletApiKey: 'testapikey1234567890abcdef',
    tabletListenAddress: 'tcp://0.0.0.0:22000',
    hostAddress: 'tcp://10.11.99.2:22000',
    guiListenAddress: '127.0.0.1:8384',
    ...overrides,
  };
}

describe('generateSyncthingConfig', () => {
  it('generates valid XML with correct structure', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<configuration version="37">');
    expect(xml).toContain('</configuration>');
  });

  it('sets folder type to sendonly (one-directional sync)', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('type="sendonly"');
  });

  it('disables global announce (zero cloud)', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<globalAnnounceEnabled>true</globalAnnounceEnabled>');
  });

  it('enables relays for cross-network sync', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<relaysEnabled>true</relaysEnabled>');
  });

  it('enables local announce for LAN discovery', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<localAnnounceEnabled>true</localAnnounceEnabled>');
  });

  it('enables NAT traversal for cross-network sync', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<natEnabled>true</natEnabled>');
  });

  it('disables auto-upgrade', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<autoUpgradeIntervalH>0</autoUpgradeIntervalH>');
  });

  it('disables crash reporting', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<crashReportingEnabled>false</crashReportingEnabled>');
  });

  it('disables usage reporting', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<urAccepted>-1</urAccepted>');
  });

  it('includes both device IDs', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain(`id="${stConfig.tabletDeviceId}"`);
    expect(xml).toContain(`id="${stConfig.hostDeviceId}"`);
  });

  it('sets host address for direct connection', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig({ hostAddress: 'tcp://192.168.1.100:22000' });

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<address>tcp://192.168.1.100:22000</address>');
  });

  it('uses correct sync folder path', () => {
    const syncConfig = createTestSyncConfig({
      tabletSyncPath: '/home/root/.local/share/remarkable/xochitl',
    });
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('path="/home/root/.local/share/remarkable/xochitl"');
  });

  it('sets databaseTuning to small for low memory', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<databaseTuning>small</databaseTuning>');
  });

  it('sets maxFolderConcurrency to 1 for single-core', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<maxFolderConcurrency>1</maxFolderConcurrency>');
  });

  it('disables browser auto-start', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<startBrowser>false</startBrowser>');
  });

  it('binds GUI to localhost only', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<address>127.0.0.1:8384</address>');
  });

  it('sets rescan interval from schedule config', () => {
    const syncConfig = createTestSyncConfig({
      schedule: { enabled: true, intervalMinutes: 10, wifiOnly: false },
    });
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    // 10 minutes * 60 = 600 seconds
    expect(xml).toContain('rescanIntervalS="600"');
  });

  it('includes API key in GUI section', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig({ tabletApiKey: 'myTestApiKey123' });

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<apikey>myTestApiKey123</apikey>');
  });

  it('escapes XML special characters in paths', () => {
    const syncConfig = createTestSyncConfig({
      tabletSyncPath: '/home/root/data & files/<test>',
    });
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;test&gt;');
  });

  it('sets low priority for CPU scheduling', () => {
    const syncConfig = createTestSyncConfig();
    const stConfig = createTestSyncthingConfig();

    const xml = generateSyncthingConfig(syncConfig, stConfig);

    expect(xml).toContain('<setLowPriority>true</setLowPriority>');
  });
});

describe('generateApiKey', () => {
  it('generates a 32-character string', () => {
    const key = generateApiKey();
    expect(key).toHaveLength(32);
  });

  it('contains only alphanumeric characters', () => {
    const key = generateApiKey();
    expect(key).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it('generates unique keys', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      keys.add(generateApiKey());
    }
    // With 62^32 possibilities, collisions are astronomically unlikely
    expect(keys.size).toBe(100);
  });
});

describe('isValidDeviceId', () => {
  it('accepts valid Syncthing device ID', () => {
    expect(isValidDeviceId('AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH')).toBe(true);
  });

  it('accepts device ID with numbers', () => {
    expect(isValidDeviceId('ABC1234-DEF5678-GHI9012-JKL3456-MNO7890-PQR1234-STU5678-VWX9012')).toBe(true);
  });

  it('rejects lowercase letters', () => {
    expect(isValidDeviceId('aaaaaaa-bbbbbbb-ccccccc-ddddddd-eeeeeee-fffffff-ggggggg-hhhhhhh')).toBe(false);
  });

  it('rejects wrong number of groups', () => {
    expect(isValidDeviceId('AAAAAAA-BBBBBBB-CCCCCCC')).toBe(false);
  });

  it('rejects wrong group length', () => {
    expect(isValidDeviceId('AAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidDeviceId('')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidDeviceId('AAAAAAA BBBBBBB CCCCCCC DDDDDDD EEEEEEE FFFFFFF GGGGGGG HHHHHHH')).toBe(false);
  });
});
