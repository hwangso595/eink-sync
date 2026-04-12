/**
 * Shared constants for highlight section markers.
 *
 * These markers delimit the auto-generated highlights section in
 * literature notes. They are used by:
 *   - markdown-renderer.ts (pipeline)
 *   - template-engine.ts (pipeline)
 *   - review-data.ts (plugin)
 *
 * Having a single source of truth prevents drift between modules.
 *
 * Privacy: No side effects. Pure constants.
 */

/** Marker that opens the managed highlights section. */
export const HIGHLIGHTS_SECTION_START =
  '<!-- remarkable-bridge:start -->';

/** Marker that closes the managed highlights section. */
export const HIGHLIGHTS_SECTION_END =
  '<!-- remarkable-bridge:end -->';
