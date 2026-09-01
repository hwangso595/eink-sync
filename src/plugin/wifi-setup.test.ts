import type { SSHConfig } from '../types/config';
import type { CommandResult, SSHExecutor } from '../ssh/ssh-client';
import {
  commitUsbConnection,
  enableVerifyAndCommitWifiConnection,
  verifyAndCommitUsbConnection,
  verifyAndCommitWifiConnection,
  type MutableConnectionSettings,
  type WifiSetupDependencies,
} from './wifi-setup';

const BASE_CONFIG: SSHConfig = {
  host: '192.168.1.9',
  port: 22,
  username: 'root',
  password: 'secret',
  timeoutMs: 10_000,
  method: 'wifi',
};

function connectionSettings(): MutableConnectionSettings {
  return {
    tabletIp: '10.11.99.1',
    wifiTabletIp: '',
    connectionMethod: 'usb',
    autoSyncEnabled: false,
  };
}

interface ClientBehavior {
  connectError?: Error;
  ping?: boolean;
  commands?: Record<string, CommandResult>;
}

class FakeClient implements SSHExecutor {
  private connected = false;

  constructor(
    private readonly behavior: ClientBehavior,
    private readonly commandsSeen: string[],
  ) {}

  async connect(): Promise<void> {
    if (this.behavior.connectError) throw this.behavior.connectError;
    this.connected = true;
  }

  async execute(command: string): Promise<CommandResult> {
    this.commandsSeen.push(command);
    return this.behavior.commands?.[command] ?? {
      stdout: '',
      stderr: '',
      exitCode: 1,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async ping(): Promise<boolean> {
    return this.behavior.ping ?? true;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function dependencies(
  usb: ClientBehavior,
  wifi: ClientBehavior = {},
): {
  deps: WifiSetupDependencies;
  configs: SSHConfig[];
  commands: string[];
  rememberAlias: jest.Mock;
} {
  const configs: SSHConfig[] = [];
  const commands: string[] = [];
  const rememberAlias = jest.fn(() => true);
  return {
    configs,
    commands,
    rememberAlias,
    deps: {
      createClient: (config) => {
        configs.push(config);
        return new FakeClient(config.method === 'usb' ? usb : wifi, commands);
      },
      getPinnedFingerprint: (host) => host === '10.11.99.1' ? 'usb-fingerprint' : null,
      rememberAlias,
    },
  };
}

const CURRENT_USB_COMMANDS: Record<string, CommandResult> = {
  'test -x /usr/bin/rm-ssh-over-wlan': {
    stdout: '/usr/bin/rm-ssh-over-wlan', stderr: '', exitCode: 0,
  },
  'systemctl is-active --quiet dropbear-wlan.socket': {
    stdout: 'inactive', stderr: '', exitCode: 3,
  },
  '/usr/bin/rm-ssh-over-wlan on': { stdout: '', stderr: '', exitCode: 0 },
  '/usr/bin/rm-ssh-over-wlan off': { stdout: '', stderr: '', exitCode: 0 },
  'ip -4 route get 1.1.1.1 2>/dev/null': {
    stdout: '1.1.1.1 via 192.168.50.1 dev mlan0 src 192.168.50.42 uid 0',
    stderr: '',
    exitCode: 0,
  },
};

describe('USB-to-WiFi setup', () => {
  it('enables current-device WiFi SSH, verifies the same host key, then persists', async () => {
    const settings = connectionSettings();
    const events: string[] = [];
    const fixture = dependencies({ commands: CURRENT_USB_COMMANDS });
    const originalCreate = fixture.deps.createClient;
    fixture.deps.createClient = (config) => {
      events.push(`connect:${config.method}`);
      return originalCreate(config);
    };
    fixture.deps.rememberAlias = (usb, wifi) => {
      events.push(`alias:${usb}:${wifi}`);
      return fixture.rememberAlias(usb, wifi);
    };
    const persist = jest.fn(async () => {
      events.push(`save:${settings.connectionMethod}:${settings.tabletIp}`);
    });

    const result = await enableVerifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      persist,
      fixture.deps,
    );

    expect(result).toEqual({
      host: '192.168.50.42',
      helperAvailable: true,
      helperEnabled: true,
      enabledByThisAttempt: true,
    });
    expect(fixture.configs[0]).toMatchObject({ host: '10.11.99.1', method: 'usb' });
    expect(fixture.configs[1]).toMatchObject({
      host: '192.168.50.42',
      method: 'wifi',
      expectedHostKeyFingerprint: 'usb-fingerprint',
    });
    expect(fixture.commands).toEqual([
      'test -x /usr/bin/rm-ssh-over-wlan',
      'systemctl is-active --quiet dropbear-wlan.socket',
      '/usr/bin/rm-ssh-over-wlan on',
      'ip -4 route get 1.1.1.1 2>/dev/null',
    ]);
    expect(events.indexOf('connect:wifi')).toBeLessThan(
      events.indexOf('save:wifi:192.168.50.42'),
    );
    expect(settings).toEqual({
      tabletIp: '192.168.50.42',
      wifiTabletIp: '192.168.50.42',
      connectionMethod: 'wifi',
      autoSyncEnabled: false,
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('supports legacy tablets where WiFi SSH is already exposed and the helper is absent', async () => {
    const settings = connectionSettings();
    const fixture = dependencies({
      commands: {
        'test -x /usr/bin/rm-ssh-over-wlan': {
          stdout: '', stderr: '', exitCode: 1,
        },
        'ip -4 route get 1.1.1.1 2>/dev/null': {
          stdout: '', stderr: '', exitCode: 2,
        },
        'ip -4 addr show scope global 2>/dev/null': {
          stdout: [
            '2: usb0 inet 10.11.99.1/29 scope global usb0',
            '3: wlan1 inet 10.0.0.77/24 scope global wlan1',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        },
      },
    });

    const result = await enableVerifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      jest.fn(async () => {}),
      fixture.deps,
    );

    expect(result).toEqual({
      host: '10.0.0.77',
      helperAvailable: false,
      helperEnabled: false,
      enabledByThisAttempt: false,
    });
    expect(fixture.commands).not.toContain('/usr/bin/rm-ssh-over-wlan on');
  });

  it('does not save or change USB settings when the WiFi endpoint fails', async () => {
    const settings = connectionSettings();
    const before = { ...settings };
    const fixture = dependencies(
      { commands: CURRENT_USB_COMMANDS },
      { connectError: new Error('ECONNREFUSED') },
    );
    const persist = jest.fn(async () => {});

    await expect(enableVerifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      persist,
      fixture.deps,
    )).rejects.toThrow('ECONNREFUSED');

    expect(settings).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
    expect(fixture.rememberAlias).not.toHaveBeenCalled();
    expect(fixture.commands.at(-1)).toBe('/usr/bin/rm-ssh-over-wlan off');
  });

  it('uses fixed shell commands and rejects unusable discovery output', async () => {
    const settings = connectionSettings();
    const fixture = dependencies({
      commands: {
        ...CURRENT_USB_COMMANDS,
        'ip -4 route get 1.1.1.1 2>/dev/null': {
          stdout: '1.1.1.1 dev usb0 src 10.11.99.1; rm -rf /',
          stderr: '',
          exitCode: 0,
        },
        'ip -4 addr show scope global 2>/dev/null': {
          stdout: '2: usb0 inet 10.11.99.1/29 scope global usb0',
          stderr: '',
          exitCode: 0,
        },
      },
    });

    await expect(enableVerifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      jest.fn(async () => {}),
      fixture.deps,
    )).rejects.toThrow('no routable WiFi IPv4 address');

    expect(fixture.commands).toEqual([
      'test -x /usr/bin/rm-ssh-over-wlan',
      'systemctl is-active --quiet dropbear-wlan.socket',
      '/usr/bin/rm-ssh-over-wlan on',
      'ip -4 route get 1.1.1.1 2>/dev/null',
      'ip -4 addr show scope global 2>/dev/null',
      '/usr/bin/rm-ssh-over-wlan off',
    ]);
  });

  it('warns when prior WiFi SSH state is unknown and setup fails after enable', async () => {
    const settings = connectionSettings();
    const fixture = dependencies({
      commands: {
        ...CURRENT_USB_COMMANDS,
        'systemctl is-active --quiet dropbear-wlan.socket': {
          stdout: 'unknown', stderr: '', exitCode: 4,
        },
      },
    }, { connectError: new Error('wrong host key') });

    await expect(enableVerifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      jest.fn(async () => {}),
      fixture.deps,
    )).rejects.toThrow('WiFi setup did not complete after the enable command');
    expect(fixture.commands).not.toContain('/usr/bin/rm-ssh-over-wlan off');
    expect(settings.connectionMethod).toBe('usb');
  });

  it('rolls local settings back if persistence fails', async () => {
    const settings = connectionSettings();
    const before = { ...settings };
    const fixture = dependencies({ commands: CURRENT_USB_COMMANDS });
    const persist = jest.fn(async () => {
      throw new Error('disk full');
    });

    await expect(enableVerifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      persist,
      fixture.deps,
    )).rejects.toThrow('disk full');

    expect(settings).toEqual(before);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

describe('manual connection changes', () => {
  it('preserves WiFi and auto-sync when USB detects a device but preflight fails', async () => {
    const settings: MutableConnectionSettings = {
      tabletIp: '192.168.1.44',
      wifiTabletIp: '192.168.1.44',
      connectionMethod: 'wifi',
      autoSyncEnabled: true,
    };
    const before = { ...settings };
    const persist = jest.fn(async () => {});

    const result = await verifyAndCommitUsbConnection(
      settings,
      async () => ({ success: false, deviceInfo: { model: 'paperPro' } }),
      persist,
      value => value.success,
    );

    expect(result).toEqual({ success: false, deviceInfo: { model: 'paperPro' } });
    expect(settings).toEqual(before);
    expect(persist).not.toHaveBeenCalled();
  });

  it('preserves auto-sync through verified USB setup and a successful WiFi handoff', async () => {
    const settings: MutableConnectionSettings = {
      tabletIp: '192.168.1.44',
      wifiTabletIp: '192.168.1.44',
      connectionMethod: 'wifi',
      autoSyncEnabled: true,
    };
    const persist = jest.fn(async () => {});

    await verifyAndCommitUsbConnection(settings, async () => 'verified', persist);
    expect(settings).toMatchObject({
      tabletIp: '10.11.99.1',
      connectionMethod: 'usb',
      autoSyncEnabled: true,
    });

    const fixture = dependencies({ commands: CURRENT_USB_COMMANDS });
    await enableVerifyAndCommitWifiConnection(BASE_CONFIG, settings, persist, fixture.deps);

    expect(settings).toMatchObject({
      tabletIp: '192.168.50.42',
      wifiTabletIp: '192.168.50.42',
      connectionMethod: 'wifi',
      autoSyncEnabled: true,
    });
  });

  it('tests a remembered WiFi endpoint before changing or saving settings', async () => {
    const settings = connectionSettings();
    settings.wifiTabletIp = '192.168.1.44';
    const fixture = dependencies({}, { connectError: new Error('timeout') });
    const persist = jest.fn(async () => {});

    await expect(verifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      settings.wifiTabletIp,
      persist,
      fixture.deps,
    )).rejects.toThrow('timeout');

    expect(settings.connectionMethod).toBe('usb');
    expect(settings.tabletIp).toBe('10.11.99.1');
    expect(persist).not.toHaveBeenCalled();
  });

  it('requires the USB device fingerprint for a new WiFi host before authentication', async () => {
    const settings = connectionSettings();
    const fixture = dependencies({}, { connectError: new Error('host key mismatch') });
    const persist = jest.fn(async () => {});

    await expect(verifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      '192.168.1.99',
      persist,
      fixture.deps,
    )).rejects.toThrow('host key mismatch');

    expect(fixture.configs[0]).toMatchObject({
      host: '192.168.1.99',
      method: 'wifi',
      expectedHostKeyFingerprint: 'usb-fingerprint',
    });
    expect(fixture.rememberAlias).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('uses an explicitly remembered endpoint fingerprint when no USB pin is available', async () => {
    const settings = connectionSettings();
    const fixture = dependencies({}, {});
    fixture.deps.getPinnedFingerprint = (host) => host === '192.168.1.44'
      ? 'remembered-fingerprint'
      : null;

    await verifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      '192.168.1.44',
      jest.fn(async () => {}),
      fixture.deps,
    );

    expect(fixture.configs[0].expectedHostKeyFingerprint).toBe('remembered-fingerprint');
    expect(fixture.rememberAlias).not.toHaveBeenCalled();
    expect(settings.connectionMethod).toBe('wifi');
  });

  it('supports a fresh USB-mode manual address with TOFU only when no identity is pinned', async () => {
    const settings = connectionSettings();
    const fixture = dependencies({}, {});
    fixture.deps.getPinnedFingerprint = () => null;
    const events: string[] = [];
    const originalCreate = fixture.deps.createClient;
    fixture.deps.createClient = (config) => {
      events.push('verify');
      return originalCreate(config);
    };
    const persist = jest.fn(async () => {
      events.push('persist');
    });

    await verifyAndCommitWifiConnection(
      BASE_CONFIG,
      settings,
      '192.168.1.55',
      persist,
      fixture.deps,
    );

    expect(fixture.configs[0]).toMatchObject({
      host: '192.168.1.55',
      method: 'wifi',
      expectedHostKeyFingerprint: undefined,
    });
    expect(events).toEqual(['verify', 'persist']);
    expect(fixture.rememberAlias).not.toHaveBeenCalled();
    expect(settings).toMatchObject({
      tabletIp: '192.168.1.55',
      wifiTabletIp: '192.168.1.55',
      connectionMethod: 'wifi',
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('selects USB while retaining the last verified WiFi address', async () => {
    const settings: MutableConnectionSettings = {
      tabletIp: '192.168.1.44',
      wifiTabletIp: '192.168.1.44',
      connectionMethod: 'wifi',
      autoSyncEnabled: true,
    };
    await commitUsbConnection(settings, jest.fn(async () => {}));
    expect(settings).toEqual({
      tabletIp: '10.11.99.1',
      wifiTabletIp: '192.168.1.44',
      connectionMethod: 'usb',
      autoSyncEnabled: true,
    });
  });
});
