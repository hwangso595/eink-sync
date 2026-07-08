/**
 * High-level connection manager that orchestrates SSH connection,
 * device detection, and pre-flight checks into a single workflow.
 *
 * This is the main entry point for the setup wizard's "Connect & Verify" step.
 */

import { SSHConfig } from '../types/config';
import { DeviceInfo } from '../types/device';
import { BridgeError, ErrorCode } from '../types/errors';
import { ReMarkableSSHClient, SSHExecutor } from './ssh-client';
import { detectDeviceInfo } from '../device/detector';
import { runPreflightChecks, formatPreflightReport, PreflightReport } from '../preflight/checks';
import { logger } from '../utils/logger';

/** Callback for reporting progress during connection and detection. */
export type ProgressCallback = (step: string, detail: string) => void;

/** Result of the full connection + detection + preflight workflow. */
export interface ConnectionResult {
  /** Whether the connection and all checks succeeded. */
  success: boolean;
  /** Device information if connection succeeded. */
  deviceInfo: DeviceInfo | null;
  /** Pre-flight report if detection succeeded. */
  preflightReport: PreflightReport | null;
  /** Human-readable summary of the result. */
  summary: string;
  /** Error if something failed. */
  error: BridgeError | null;
}

/**
 * Connect to the reMarkable, detect device info, and run pre-flight checks.
 *
 * This is designed to be called from the setup wizard. It provides progress
 * callbacks so the UI can show step-by-step progress.
 *
 * The SSH connection is closed before returning -- this is a one-shot check,
 * not a persistent connection.
 *
 * @param config - SSH configuration with host, port, username, password.
 * @param onProgress - Optional callback for UI progress updates.
 * @param sshClient - Optional injected SSH client for testability. Defaults to ReMarkableSSHClient.
 */
export async function connectAndVerify(
  config: SSHConfig,
  onProgress?: ProgressCallback,
  sshClient?: SSHExecutor,
): Promise<ConnectionResult> {
  const ssh = sshClient ?? new ReMarkableSSHClient(config);
  const progress = onProgress ?? (() => {});

  try {
    // Step 1: Establish SSH connection
    progress('Connecting', `Establishing SSH connection to ${config.host}...`);
    await ssh.connect();

    // Step 2: Verify it responds
    progress('Verifying', 'Verifying device responds to commands...');
    const isAlive = await ssh.ping();
    if (!isAlive) {
      throw new BridgeError(
        ErrorCode.DEVICE_NOT_REMARKABLE,
        'Device connected but does not respond to commands.',
        'The device may be busy or in an unexpected state. Try again.',
      );
    }

    // Step 3: Detect device information
    progress('Detecting', 'Reading firmware version and device model...');
    const deviceInfo = await detectDeviceInfo(ssh);

    // Step 4: Run pre-flight checks
    progress('Checking', 'Running pre-flight compatibility checks...');
    const preflightReport = await runPreflightChecks(deviceInfo, ssh);

    // Step 5: Build summary
    const summary = formatPreflightReport(preflightReport);
    progress('Complete', preflightReport.passed ? 'All checks passed!' : 'Some checks failed. See report for details.');

    logger.info('Connection and verification complete');

    return {
      success: preflightReport.passed,
      deviceInfo,
      preflightReport,
      summary,
      error: null,
    };
  } catch (err) {
    const bridgeError = err instanceof BridgeError
      ? err
      : new BridgeError(
          ErrorCode.SSH_COMMAND_FAILED,
          `Unexpected error: ${(err as Error).message}`,
          'Check your connection settings and try again.',
          err as Error,
        );

    logger.error(`Connection failed: ${bridgeError.message}`);

    return {
      success: false,
      deviceInfo: null,
      preflightReport: null,
      summary: bridgeError.toUserMessage(),
      error: bridgeError,
    };
  } finally {
    // Always clean up the SSH connection
    await ssh.disconnect();
  }
}

/**
 * Quick connectivity test -- just checks if SSH works.
 *
 * Lighter than connectAndVerify; useful for status bar health checks.
 */
export async function testConnection(
  config: SSHConfig,
  sshClient?: SSHExecutor,
): Promise<boolean> {
  return (await testConnectionDetailed(config, sshClient)).ok;
}

/** Outcome of a detailed connectivity test. */
export interface ConnectionTestResult {
  /** Whether SSH connected and the device responded. */
  ok: boolean;
  /** The specific failure, preserved so the UI can explain *why* it failed. */
  error: BridgeError | null;
}

/**
 * Like {@link testConnection} but preserves the specific failure reason
 * (timeout vs. auth vs. connection-refused vs. unreachable) instead of
 * collapsing everything to a bare boolean. The SSH layer already produces a
 * precise, actionable BridgeError — this surfaces it so callers can show the
 * user something better than "Failed".
 */
export async function testConnectionDetailed(
  config: SSHConfig,
  sshClient?: SSHExecutor,
): Promise<ConnectionTestResult> {
  const ssh = sshClient ?? new ReMarkableSSHClient(config);
  try {
    await ssh.connect();
    const alive = await ssh.ping();
    if (!alive) {
      return {
        ok: false,
        error: new BridgeError(
          ErrorCode.DEVICE_NOT_REMARKABLE,
          'Connected, but the device did not respond to a test command.',
          'The tablet may be busy. Try again in a moment.',
        ),
      };
    }
    return { ok: true, error: null };
  } catch (err) {
    const bridgeError = err instanceof BridgeError
      ? err
      : new BridgeError(
          ErrorCode.SSH_COMMAND_FAILED,
          `Unexpected error: ${(err as Error).message}`,
          'Check your connection settings and try again.',
          err as Error,
        );
    return { ok: false, error: bridgeError };
  } finally {
    await ssh.disconnect();
  }
}
