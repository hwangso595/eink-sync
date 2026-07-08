/**
 * Systemd service management for Syncthing on the reMarkable.
 *
 * The plugin no longer deploys Syncthing programmatically -- users pair and
 * configure Syncthing through its own web UI (see the setup wizard). What
 * remains here is the teardown path: when the user switches away from
 * Syncthing (e.g. to SFTP) or removes the integration, we stop and delete
 * the `eink-sync*` systemd units this plugin may have created on older setups.
 *
 * Safety: every command suppresses "unit not found" errors so a tablet that
 * was never set up under this plugin ends up in the same clean state as one
 * that was.
 */

import type { SSHExecutor } from '../ssh/ssh-client';
import {
  SYNCTHING_SERVICE_NAME,
  SYNCTHING_SERVICE_PATH,
  WATCHDOG_SERVICE_NAME,
  WATCHDOG_SERVICE_PATH,
  WATCHDOG_SCRIPT_PATH,
} from './types';
import { logger } from '../utils/logger';

/** Timeout for service management commands. */
const SERVICE_TIMEOUT_MS = 15_000;

/**
 * Stop and disable the Syncthing and watchdog services.
 */
export async function stopServices(ssh: SSHExecutor): Promise<void> {
  logger.info('Stopping Syncthing services...');

  // Stop both services (order: watchdog first, then Syncthing)
  await ssh.execute(
    `systemctl stop ${WATCHDOG_SERVICE_NAME} 2>/dev/null; ` +
    `systemctl disable ${WATCHDOG_SERVICE_NAME} 2>/dev/null; ` +
    `systemctl stop ${SYNCTHING_SERVICE_NAME} 2>/dev/null; ` +
    `systemctl disable ${SYNCTHING_SERVICE_NAME} 2>/dev/null`,
    SERVICE_TIMEOUT_MS,
  );

  logger.info('Syncthing services stopped');
}

/**
 * Remove all service files from the tablet.
 *
 * This is the cleanup step for uninstallation. Stops services first.
 */
export async function removeServices(ssh: SSHExecutor): Promise<void> {
  logger.info('Removing Syncthing service files...');

  await stopServices(ssh);

  await ssh.execute(
    `rm -f ${SYNCTHING_SERVICE_PATH} ${WATCHDOG_SERVICE_PATH} ${WATCHDOG_SCRIPT_PATH} && ` +
    'systemctl daemon-reload',
    SERVICE_TIMEOUT_MS,
  );

  await removeLegacyServices(ssh);

  logger.info('Syncthing service files removed');
}

/**
 * Remove the pre-rename plugin's `remarkable-sync*` units so an upgraded user
 * isn't left with an old daemon running after teardown. Best-effort/idempotent.
 */
async function removeLegacyServices(ssh: SSHExecutor): Promise<void> {
  await ssh.execute(
    'systemctl stop remarkable-sync-watchdog 2>/dev/null; ' +
    'systemctl disable remarkable-sync-watchdog 2>/dev/null; ' +
    'systemctl stop remarkable-sync 2>/dev/null; ' +
    'systemctl disable remarkable-sync 2>/dev/null; ' +
    'rm -f /etc/systemd/system/remarkable-sync.service /etc/systemd/system/remarkable-sync-watchdog.service; ' +
    'systemctl daemon-reload 2>/dev/null; true',
    SERVICE_TIMEOUT_MS,
  );
}
