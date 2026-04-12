/**
 * Syncthing XML configuration generator for the reMarkable tablet.
 *
 * Generates a local-only, privacy-first Syncthing config:
 * - globalAnnounceEnabled=true (enables cross-network discovery)
 * - relaysEnabled=true (enables relay for cross-network sync; data is end-to-end encrypted)
 * - Local discovery only via LAN broadcast
 * - Send-only folder on the tablet (one-directional sync)
 * - Memory limits tuned for rM1's 512MB constraint
 *
 * The generated XML is written to the tablet via SSH. We generate it
 * programmatically rather than shipping a template to keep the config
 * tightly coupled to the user's actual device IDs and paths.
 */

import type { SyncthingConfig, SyncConfig } from './types';
import {
  XOCHITL_SYNC_PATH,
  SYNCTHING_LISTEN_PORT,
  SYNCTHING_GUI_PORT,
  RM1_MAX_SYNCTHING_RSS_MB,
} from './types';

/** Escape special XML characters in attribute values and text content. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate a complete Syncthing config.xml for the tablet.
 *
 * This config is designed to be written to SYNCTHING_CONFIG_DIR/config.xml
 * on the tablet. It configures:
 * - A single "Send Only" folder pointing at the xochitl directory
 * - The host device as the only peer
 * - Local-only discovery (no global announce, no relays)
 * - Conservative resource limits for rM1 hardware
 *
 * @param syncConfig - Full sync configuration.
 * @param syncthingConfig - Syncthing-specific settings (device IDs, addresses).
 */
export function generateSyncthingConfig(
  syncConfig: SyncConfig,
  syncthingConfig: SyncthingConfig,
): string {
  const folderPath = escapeXml(syncConfig.tabletSyncPath || XOCHITL_SYNC_PATH);
  const tabletDeviceId = escapeXml(syncthingConfig.tabletDeviceId);
  const hostDeviceId = escapeXml(syncthingConfig.hostDeviceId);
  const hostAddress = escapeXml(syncthingConfig.hostAddress);
  const apiKey = escapeXml(syncthingConfig.tabletApiKey);
  const listenAddress = escapeXml(
    syncthingConfig.tabletListenAddress || `tcp://0.0.0.0:${SYNCTHING_LISTEN_PORT}`,
  );
  const guiAddress = escapeXml(
    syncthingConfig.guiListenAddress || `127.0.0.1:${SYNCTHING_GUI_PORT}`,
  );

  // Memory limit: use the device-specific budget, default to rM1-safe value
  const maxMemoryMB = syncConfig.resourceBudget.syncthingMaxMemoryMB || RM1_MAX_SYNCTHING_RSS_MB;

  return `<configuration version="37">
    <folder id="remarkable-xochitl" label="reMarkable Documents" path="${folderPath}" type="sendonly" rescanIntervalS="${syncConfig.schedule.intervalMinutes * 60}" fsWatcherEnabled="true" fsWatcherDelayS="10" ignorePerms="false" autoNormalize="true">
        <filesystemType>basic</filesystemType>
        <device id="${tabletDeviceId}" introducedBy="">
            <encryptionPassword></encryptionPassword>
        </device>
        <device id="${hostDeviceId}" introducedBy="">
            <encryptionPassword></encryptionPassword>
        </device>
        <minDiskFree unit="%">1</minDiskFree>
        <versioning>
            <cleanupIntervalS>3600</cleanupIntervalS>
        </versioning>
        <copiers>1</copiers>
        <pullerMaxPendingKiB>0</pullerMaxPendingKiB>
        <hashers>0</hashers>
        <order>random</order>
        <ignoreDelete>false</ignoreDelete>
        <scanProgressIntervalS>0</scanProgressIntervalS>
        <pullerPauseS>0</pullerPauseS>
        <maxConflicts>-1</maxConflicts>
        <disableSparseFiles>false</disableSparseFiles>
        <disableTempIndexes>false</disableTempIndexes>
        <paused>false</paused>
        <weakHashThresholdPct>25</weakHashThresholdPct>
        <markerName>.stfolder</markerName>
        <copyOwnershipFromParent>false</copyOwnershipFromParent>
        <modTimeWindowS>0</modTimeWindowS>
        <maxConcurrentWrites>2</maxConcurrentWrites>
        <disableFsync>false</disableFsync>
        <blockPullOrder>standard</blockPullOrder>
        <copyRangeMethod>standard</copyRangeMethod>
        <caseSensitiveFS>true</caseSensitiveFS>
        <junctionsAsDirs>false</junctionsAsDirs>
    </folder>
    <device id="${tabletDeviceId}" name="reMarkable" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">
        <address>dynamic</address>
        <paused>false</paused>
        <autoAcceptFolders>false</autoAcceptFolders>
        <maxSendKbps>0</maxSendKbps>
        <maxRecvKbps>0</maxRecvKbps>
        <maxRequestKiB>0</maxRequestKiB>
        <untrusted>false</untrusted>
        <remoteGUIPort>0</remoteGUIPort>
        <numConnections>0</numConnections>
    </device>
    <device id="${hostDeviceId}" name="Host" compression="metadata" introducer="false" skipIntroductionRemovals="false" introducedBy="">
        <address>${hostAddress}</address>
        <paused>false</paused>
        <autoAcceptFolders>false</autoAcceptFolders>
        <maxSendKbps>0</maxSendKbps>
        <maxRecvKbps>0</maxRecvKbps>
        <maxRequestKiB>0</maxRequestKiB>
        <untrusted>false</untrusted>
        <remoteGUIPort>0</remoteGUIPort>
        <numConnections>0</numConnections>
    </device>
    <gui enabled="true" tls="false" debugging="false">
        <address>${guiAddress}</address>
        <apikey>${apiKey}</apikey>
        <theme>default</theme>
    </gui>
    <ldap></ldap>
    <options>
        <listenAddress>${listenAddress}</listenAddress>
        <globalAnnounceServer>default</globalAnnounceServer>
        <globalAnnounceEnabled>true</globalAnnounceEnabled>
        <localAnnounceEnabled>true</localAnnounceEnabled>
        <localAnnouncePort>21027</localAnnouncePort>
        <localAnnounceMCAddr>[ff12::8384]:21027</localAnnounceMCAddr>
        <maxSendKbps>0</maxSendKbps>
        <maxRecvKbps>0</maxRecvKbps>
        <reconnectionIntervalS>60</reconnectionIntervalS>
        <relaysEnabled>true</relaysEnabled>
        <relayReconnectIntervalM>10</relayReconnectIntervalM>
        <startBrowser>false</startBrowser>
        <natEnabled>true</natEnabled>
        <natLeaseMinutes>60</natLeaseMinutes>
        <natRenewalMinutes>30</natRenewalMinutes>
        <natTimeoutSeconds>10</natTimeoutSeconds>
        <urAccepted>-1</urAccepted>
        <urSeen>3</urSeen>
        <urURL></urURL>
        <urPostInsecurely>false</urPostInsecurely>
        <urInitialDelayS>1800</urInitialDelayS>
        <autoUpgradeIntervalH>0</autoUpgradeIntervalH>
        <upgradeToPreReleases>false</upgradeToPreReleases>
        <keepTemporariesH>24</keepTemporariesH>
        <cacheIgnoredFiles>false</cacheIgnoredFiles>
        <progressUpdateIntervalS>5</progressUpdateIntervalS>
        <limitBandwidthInLan>false</limitBandwidthInLan>
        <minHomeDiskFree unit="%">1</minHomeDiskFree>
        <releasesURL></releasesURL>
        <overwriteRemoteDeviceNamesOnConnect>false</overwriteRemoteDeviceNamesOnConnect>
        <tempIndexMinBlocks>10</tempIndexMinBlocks>
        <unackedNotificationID>authenticationUserAndPassword</unackedNotificationID>
        <trafficClass>0</trafficClass>
        <setLowPriority>true</setLowPriority>
        <maxFolderConcurrency>1</maxFolderConcurrency>
        <crashReportingURL></crashReportingURL>
        <crashReportingEnabled>false</crashReportingEnabled>
        <stunKeepaliveStartS>180</stunKeepaliveStartS>
        <stunKeepaliveMinS>20</stunKeepaliveMinS>
        <stunServer></stunServer>
        <databaseTuning>small</databaseTuning>
        <maxConcurrentIncomingRequestKiB>0</maxConcurrentIncomingRequestKiB>
        <announceLANAddresses>true</announceLANAddresses>
        <sendFullIndexOnUpgrade>false</sendFullIndexOnUpgrade>
        <connectionLimitEnough>0</connectionLimitEnough>
        <connectionLimitMax>0</connectionLimitMax>
        <insecureAllowOldTLSVersions>false</insecureAllowOldTLSVersions>
        <connectionPriorityTcpLan>10</connectionPriorityTcpLan>
        <connectionPriorityQuicLan>20</connectionPriorityQuicLan>
        <connectionPriorityTcpWan>30</connectionPriorityTcpWan>
        <connectionPriorityQuicWan>40</connectionPriorityQuicWan>
        <connectionPriorityRelay>50</connectionPriorityRelay>
    </options>
</configuration>`;
}

/**
 * Generate an API key for Syncthing.
 *
 * Produces a random 32-character hex string. This is used for the
 * tablet-side Syncthing REST API and is not security-critical since
 * the GUI is bound to localhost only.
 */
export function generateApiKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Validate that a Syncthing device ID has the correct format.
 *
 * Syncthing device IDs are 56-character strings in groups of 7,
 * separated by hyphens (e.g., "AAAAAAA-BBBBBBB-CCCCCCC-...").
 */
export function isValidDeviceId(deviceId: string): boolean {
  // Syncthing device IDs: 8 groups of 7 alphanumeric chars, separated by hyphens
  const pattern = /^[A-Z0-9]{7}(-[A-Z0-9]{7}){7}$/;
  return pattern.test(deviceId);
}
