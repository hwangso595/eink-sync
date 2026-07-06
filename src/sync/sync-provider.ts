/**
 * SyncProvider abstraction -- unified interface for pulling files from a
 * reMarkable tablet regardless of the underlying transport (SFTP or Syncthing).
 *
 * Each provider encapsulates its own connection logic so callers never need
 * to branch on `syncMethod`. Plugin code simply calls `provider.sync()`.
 *
 * Privacy: Both implementations communicate only with the user's tablet
 * or localhost Syncthing API. No external network calls.
 */

/**
 * Callback for reporting sync progress to the UI.
 *
 * @param phase - Current phase name (e.g. 'connecting', 'downloading', 'complete').
 * @param detail - Human-readable detail string.
 * @param current - Current item index (1-based) when downloading files.
 * @param total - Total number of items.
 */
export type SyncProgressCallback = (
  phase: string,
  detail: string,
  current?: number,
  total?: number,
) => void;

/** Result of a sync operation. */
export interface SyncResult {
  /**
   * Whether the transfer fully succeeded. Implementations guarantee
   * `success === true` implies `errors` is empty; any failed file/API call sets
   * `success = false`. Callers that treat a run as "clean" should still check
   * both to be defensive.
   */
  success: boolean;
  /** Number of files downloaded from the tablet. */
  filesDownloaded: number;
  /** Number of files skipped (already up to date). */
  filesSkipped: number;
  /** Human-readable summary string. */
  summary: string;
  /** Non-fatal error messages encountered during sync. */
  errors: string[];
}

/**
 * Abstract sync transport. Implementations handle SFTP or Syncthing specifics.
 */
export interface SyncProvider {
  /** Pull latest files from tablet to local sync folder. */
  sync(onProgress?: SyncProgressCallback, sourceId?: string): Promise<SyncResult>;

  /** Check if the tablet/sync source is reachable. */
  isAvailable(): Promise<boolean>;

  /** Pause syncing (e.g. pause Syncthing folder). No-op for on-demand transports. */
  pause(): Promise<void>;

  /** Resume syncing. No-op for on-demand transports. */
  resume(): Promise<void>;

  /**
   * Clean up sync infrastructure (e.g. stop/remove Syncthing on tablet,
   * pause host folder). Called when switching away from this provider.
   */
  remove(): Promise<void>;
}
