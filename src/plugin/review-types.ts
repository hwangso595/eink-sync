/**
 * Type definitions for the Highlight Review Workflow.
 *
 * These types model the review state for highlights that have been
 * extracted but not yet accepted into the user's vault notes.
 *
 * The review workflow uses a simple state machine per highlight:
 *   pending -> accepted | dismissed | edited
 *
 * Dismissed highlights can be undone (returned to pending).
 */

import type { ExtractedHighlight } from '../pipeline/types';

/** The review state of a single highlight. */
export type HighlightReviewStatus =
  | 'pending'     // Awaiting user decision
  | 'accepted'    // User accepted the highlight
  | 'edited'      // User edited and accepted the highlight
  | 'dismissed';  // User dismissed (can be undone)

/** A highlight with review state attached. */
export interface ReviewableHighlight {
  /** Unique ID for this review item (uuid + page + index). */
  id: string;
  /** The extracted highlight data. */
  highlight: ExtractedHighlight;
  /** Current review status. */
  status: HighlightReviewStatus;
  /** Edited text (if the user modified the highlight). */
  editedText: string | null;
  /** The document UUID this highlight belongs to. */
  documentUuid: string;
  /** The document's visible name. */
  documentName: string;
  /** Source PDF filename for link generation. */
  sourcePdfName: string;
}

/** A document with its pending highlights for review. */
export interface ReviewableDocument {
  /** Document UUID. */
  uuid: string;
  /** Human-readable document name. */
  name: string;
  /** Source PDF filename. */
  sourcePdfName: string;
  /** Last modified timestamp (epoch ms). */
  lastModified: number;
  /** All reviewable highlights for this document. */
  highlights: ReviewableHighlight[];
  /** Count of pending (unreviewed) highlights. */
  pendingCount: number;
}

/** Summary statistics for the review panel header. */
export interface ReviewSummary {
  /** Total documents with pending highlights. */
  documentsWithPending: number;
  /** Total pending highlights across all documents. */
  totalPending: number;
  /** Total accepted in this session. */
  totalAccepted: number;
  /** Total dismissed in this session. */
  totalDismissed: number;
}

/**
 * Persisted review state for highlights.
 *
 * Stored in the plugin's data.json alongside settings.
 * Tracks which highlights have been reviewed so they don't
 * reappear after extraction re-runs.
 */
export interface PersistedReviewState {
  /** Map of highlight ID -> review status for processed highlights. */
  reviewedHighlights: Record<string, HighlightReviewStatus>;
  /** Highlights that were dismissed (can be undone). */
  dismissedHighlights: string[];
  /** Timestamp of last review session. */
  lastReviewTimestamp: number | null;
}

/** Default persisted review state. */
export const DEFAULT_REVIEW_STATE: PersistedReviewState = {
  reviewedHighlights: {},
  dismissedHighlights: [],
  lastReviewTimestamp: null,
};
