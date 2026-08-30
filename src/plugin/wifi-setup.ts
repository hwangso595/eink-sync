/**
 * Safe USB-to-WiFi connection handoff.
 *
 * WiFi SSH is enabled only after an explicit caller action has authenticated
 * to the tablet over its fixed USB address. The discovered WiFi endpoint must
 * present the same SSH host key and answer a command before callers persist it.
 */

import type { SSHConfig } from '../types/config';
import { BridgeError, ErrorCode } from '../types/errors';
import { ReMarkableSSHClient, type SSHExecutor } from '../ssh/ssh-client';
import {
  getPinnedHostFingerprint,
  rememberVerifiedHostAlias,
} from '../ssh/host-key-store';
import {
  USB_TABLET_IP,
  isUsableWifiAddress,
  parseGlobalIpv4,
  parseRouteSourceIpv4,
} from './net-utils';

const ROUTE_ADDRESS_COMMAND = 'ip -4 route get 1.1.1.1 2>/dev/null';
const GLOBAL_ADDRESSES_COMMAND = 'ip -4 addr show scope global 2>/dev/null';
const WIFI_HELPER_PROBE_COMMAND = 'test -x /usr/bin/rm-ssh-over-wlan';
const WIFI_SOCKET_STATE_COMMAND = 'systemctl is-active --quiet dropbear-wlan.socket';
const WIFI_ENABLE_COMMAND = '/usr/bin/rm-ssh-over-wlan on';
const WIFI_DISABLE_COMMAND = '/usr/bin/rm-ssh-over-wlan off';

export interface WifiTransitionResult {
  host: string;
  /** Current firmware exposed the vendor WiFi SSH control utility. */
  helperAvailable: boolean;
  /** The utility was successfully asked to enable WiFi SSH. */
  helperEnabled: boolean;
  /** True/false when the prior socket state was known, otherwise null. */
  enabledByThisAttempt: boolean | null;
}

export interface WifiSetupDependencies {
  createClient(config: SSHConfig): SSHExecutor;
  getPinnedFingerprint(host: string): string | null;
  rememberAlias(trustedHost: string, verifiedAlias: string): boolean;
}

const DEFAULT_DEPENDENCIES: WifiSetupDependencies = {
  createClient: (config) => new ReMarkableSSHClient(config),
  getPinnedFingerprint: getPinnedHostFingerprint,
  rememberAlias: rememberVerifiedHostAlias,
};

/** The connection-related settings changed by a transport handoff. */
export interface MutableConnectionSettings {
  tabletIp: string;
  wifiTabletIp: string;
  connectionMethod: 'usb' | 'wifi';
  autoSyncEnabled: boolean;
}

interface ConnectionSnapshot extends MutableConnectionSettings {}

function snapshotConnection(settings: MutableConnectionSettings): ConnectionSnapshot {
  return {
    tabletIp: settings.tabletIp,
    wifiTabletIp: settings.wifiTabletIp,
    connectionMethod: settings.connectionMethod,
    autoSyncEnabled: settings.autoSyncEnabled,
  };
}

function restoreConnection(
  settings: MutableConnectionSettings,
  snapshot: ConnectionSnapshot,
): void {
  settings.tabletIp = snapshot.tabletIp;
  settings.wifiTabletIp = snapshot.wifiTabletIp;
  settings.connectionMethod = snapshot.connectionMethod;
  settings.autoSyncEnabled = snapshot.autoSyncEnabled;
}

async function persistWithRollback(
  settings: MutableConnectionSettings,
  previous: ConnectionSnapshot,
  persist: () => Promise<void>,
): Promise<void> {
  try {
    await persist();
  } catch (err) {
    restoreConnection(settings, previous);
    // A persistence layer can theoretically write and then throw. Make one
    // best-effort save of the restored values; preserve the original error.
    try {
      await persist();
    } catch {
      // The in-memory rollback is still authoritative for the running plugin.
    }
    throw err;
  }
}

/** Discover the address chosen by the tablet's route, with no wlan0 assumption. */
export async function discoverWifiAddress(ssh: SSHExecutor): Promise<string | null> {
  const route = await ssh.execute(ROUTE_ADDRESS_COMMAND);
  const routeAddress = route.exitCode === 0
    ? parseRouteSourceIpv4(route.stdout)
    : null;
  if (routeAddress) return routeAddress;

  const addresses = await ssh.execute(GLOBAL_ADDRESSES_COMMAND);
  return addresses.exitCode === 0 ? parseGlobalIpv4(addresses.stdout) : null;
}

/**
 * Connect to and ping a WiFi endpoint. When `expectedFingerprint` is supplied,
 * credentials are sent only if it presents the key already seen over USB.
 */
export async function verifyWifiEndpoint(
  baseConfig: SSHConfig,
  host: string,
  expectedFingerprint?: string,
  dependencies: WifiSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (!isUsableWifiAddress(host)) {
    throw new BridgeError(
      ErrorCode.SSH_HOST_UNREACHABLE,
      `Invalid tablet WiFi address: "${host}".`,
      'Enter the IPv4 address shown in the tablet network settings.',
    );
  }

  const ssh = dependencies.createClient({
    ...baseConfig,
    host,
    method: 'wifi',
    expectedHostKeyFingerprint: expectedFingerprint,
  });
  try {
    await ssh.connect();
    if (!await ssh.ping()) {
      throw new BridgeError(
        ErrorCode.DEVICE_NOT_REMARKABLE,
        `The SSH service at ${host} did not answer the tablet test command.`,
        'Keep the tablet awake and confirm that WiFi SSH is enabled.',
      );
    }
  } finally {
    await ssh.disconnect();
  }
}

/**
 * Explicitly enable (when supported), discover, and verify WiFi over an
 * authenticated USB session. This function never changes plugin settings.
 */
export async function enableAndVerifyWifiViaUsb(
  baseConfig: SSHConfig,
  dependencies: WifiSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<WifiTransitionResult> {
  const usbConfig: SSHConfig = {
    ...baseConfig,
    host: USB_TABLET_IP,
    method: 'usb',
    expectedHostKeyFingerprint: undefined,
  };
  const usb = dependencies.createClient(usbConfig);
  let helperAvailable = false;
  let helperEnabled = false;
  let enabledByThisAttempt: boolean | null = false;

  try {
    await usb.connect();
    if (!await usb.ping()) {
      throw new BridgeError(
        ErrorCode.DEVICE_NOT_REMARKABLE,
        'The authenticated USB connection did not answer the tablet test command.',
        'Keep the tablet unlocked and reconnect its data-capable USB cable.',
      );
    }

    // The helper exists on current Developer Mode firmware. Legacy tablets
    // commonly expose SSH on WiFi already, so absence is safe and read-only.
    const helper = await usb.execute(WIFI_HELPER_PROBE_COMMAND);
    helperAvailable = helper.exitCode === 0;
    if (helperAvailable) {
      const priorState = await usb.execute(WIFI_SOCKET_STATE_COMMAND);
      enabledByThisAttempt = priorState.exitCode === 3
        ? true
        : priorState.exitCode === 0 ? false : null;
      const enabled = await usb.execute(WIFI_ENABLE_COMMAND);
      if (enabled.exitCode !== 0) {
        throw new BridgeError(
          ErrorCode.SSH_COMMAND_FAILED,
          'The tablet refused to enable SSH over WiFi.',
          'Confirm Developer Mode is active, then retry while connected over USB.',
        );
      }
      helperEnabled = true;
    }

    const host = await discoverWifiAddress(usb);
    if (!host) {
      throw new BridgeError(
        ErrorCode.SSH_HOST_UNREACHABLE,
        'The tablet has no routable WiFi IPv4 address.',
        'Connect the tablet and this computer to the same WiFi network, then retry.',
      );
    }

    const usbFingerprint = dependencies.getPinnedFingerprint(USB_TABLET_IP);
    if (!usbFingerprint) {
      throw new BridgeError(
        ErrorCode.SSH_COMMAND_FAILED,
        'The plugin could not retain the authenticated USB host key.',
        'Retry the USB connection before enabling WiFi.',
      );
    }

    // Keep USB open until the second connection proves it is the same tablet;
    // this lets us restore a newly enabled socket if verification fails.
    await verifyWifiEndpoint(baseConfig, host, usbFingerprint, dependencies);
    if (!dependencies.rememberAlias(USB_TABLET_IP, host)) {
      throw new BridgeError(
        ErrorCode.SSH_COMMAND_FAILED,
        'The verified WiFi endpoint could not be linked to the USB tablet identity.',
        'Keep using USB and retry WiFi setup.',
      );
    }

    return { host, helperAvailable, helperEnabled, enabledByThisAttempt };
  } catch (err) {
    if (helperEnabled && enabledByThisAttempt === true) {
      try {
        const rollback = await usb.execute(WIFI_DISABLE_COMMAND);
        if (rollback.exitCode !== 0) throw new Error('disable command failed');
      } catch {
        throw wifiMayRemainEnabledError(err);
      }
    } else if (helperEnabled && enabledByThisAttempt === null) {
      throw wifiMayRemainEnabledError(err);
    }
    throw err;
  } finally {
    await usb.disconnect();
  }
}

function wifiMayRemainEnabledError(cause: unknown): BridgeError {
  const detail = cause instanceof Error ? ` ${cause.message}` : '';
  return new BridgeError(
    ErrorCode.SSH_COMMAND_FAILED,
    `WiFi setup did not complete after the enable command.${detail}`,
    'Plugin settings remain unchanged and the previous connection remains selected, but WiFi SSH may ' +
      'still be enabled. Reconnect over USB and run rm-ssh-over-wlan off if you ' +
      'do not want SSH exposed on the local network.',
    cause instanceof Error ? cause : undefined,
  );
}

async function disableWifiViaUsb(
  baseConfig: SSHConfig,
  dependencies: WifiSetupDependencies,
): Promise<boolean> {
  const usb = dependencies.createClient({
    ...baseConfig,
    host: USB_TABLET_IP,
    method: 'usb',
    expectedHostKeyFingerprint: undefined,
  });
  try {
    await usb.connect();
    const result = await usb.execute(WIFI_DISABLE_COMMAND);
    return result.exitCode === 0;
  } catch {
    return false;
  } finally {
    await usb.disconnect();
  }
}

/** Persist a verified WiFi endpoint, restoring the previous mode on save error. */
export async function commitVerifiedWifiConnection(
  settings: MutableConnectionSettings,
  host: string,
  persist: () => Promise<void>,
): Promise<void> {
  if (!isUsableWifiAddress(host)) {
    throw new Error(`Invalid tablet WiFi address: "${host}".`);
  }
  const previous = snapshotConnection(settings);
  settings.tabletIp = host;
  settings.wifiTabletIp = host;
  settings.connectionMethod = 'wifi';
  await persistWithRollback(settings, previous, persist);
}

/** Run the complete explicit USB handoff and commit only its verified result. */
export async function enableVerifyAndCommitWifiConnection(
  baseConfig: SSHConfig,
  settings: MutableConnectionSettings,
  persist: () => Promise<void>,
  dependencies: WifiSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<WifiTransitionResult> {
  const result = await enableAndVerifyWifiViaUsb(baseConfig, dependencies);
  try {
    await commitVerifiedWifiConnection(settings, result.host, persist);
  } catch (err) {
    if (result.enabledByThisAttempt === true) {
      if (!await disableWifiViaUsb(baseConfig, dependencies)) {
        throw wifiMayRemainEnabledError(err);
      }
    } else if (result.helperEnabled && result.enabledByThisAttempt === null) {
      throw wifiMayRemainEnabledError(err);
    }
    throw err;
  }
  return result;
}

/** Verify a manually supplied/remembered WiFi address before selecting it. */
export async function verifyAndCommitWifiConnection(
  baseConfig: SSHConfig,
  settings: MutableConnectionSettings,
  host: string,
  persist: () => Promise<void>,
  dependencies: WifiSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  await verifyWifiEndpoint(baseConfig, host, undefined, dependencies);
  await commitVerifiedWifiConnection(settings, host, persist);
}

/** Select the fixed USB endpoint while retaining the last verified WiFi IP. */
export async function commitUsbConnection(
  settings: MutableConnectionSettings,
  persist: () => Promise<void>,
): Promise<void> {
  const previous = snapshotConnection(settings);
  if (isUsableWifiAddress(settings.tabletIp)) {
    settings.wifiTabletIp = settings.tabletIp;
  }
  settings.tabletIp = USB_TABLET_IP;
  settings.connectionMethod = 'usb';
  settings.autoSyncEnabled = false;
  await persistWithRollback(settings, previous, persist);
}
