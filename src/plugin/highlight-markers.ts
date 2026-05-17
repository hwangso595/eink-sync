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
  '<!-- eink-sync:start -->';

/** Marker that closes the managed highlights section. */
export const HIGHLIGHTS_SECTION_END =
  '<!-- eink-sync:end -->';

/**
 * Legacy markers from the pre-rename `remarkable-bridge` id.
 *
 * Notes written by older versions of the plugin still contain these.
 * Read paths must accept either marker so existing vaults migrate
 * transparently on the next write — at which point the section is
 * re-emitted using the current markers above.
 */
export const LEGACY_HIGHLIGHTS_SECTION_START =
  '<!-- remarkable-bridge:start -->';

export const LEGACY_HIGHLIGHTS_SECTION_END =
  '<!-- remarkable-bridge:end -->';

/**
 * Find the start marker in `content`, accepting either current or legacy form.
 * Returns `{ index, marker }` or `null` when neither is present.
 */
export function findHighlightsStart(
  content: string,
): { index: number; marker: string } | null {
  const i = content.indexOf(HIGHLIGHTS_SECTION_START);
  if (i !== -1) return { index: i, marker: HIGHLIGHTS_SECTION_START };
  const j = content.indexOf(LEGACY_HIGHLIGHTS_SECTION_START);
  if (j !== -1) return { index: j, marker: LEGACY_HIGHLIGHTS_SECTION_START };
  return null;
}

/**
 * Find the end marker in `content`, accepting either current or legacy form.
 * Returns `{ index, marker }` or `null` when neither is present.
 */
export function findHighlightsEnd(
  content: string,
): { index: number; marker: string } | null {
  const i = content.indexOf(HIGHLIGHTS_SECTION_END);
  if (i !== -1) return { index: i, marker: HIGHLIGHTS_SECTION_END };
  const j = content.indexOf(LEGACY_HIGHLIGHTS_SECTION_END);
  if (j !== -1) return { index: j, marker: LEGACY_HIGHLIGHTS_SECTION_END };
  return null;
}
