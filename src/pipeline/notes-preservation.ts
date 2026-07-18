/**
 * Loss-proof preservation of typed user notes across note regeneration.
 *
 * Highlight notes contain `<!-- notes --> ... <!-- /notes -->` blocks as slots
 * for the user's own typed input. That input must survive EVERY regeneration
 * of the managed section — the previous implementation re-inserted notes
 * positionally (Nth old block -> Nth new block), which silently destroyed all
 * of them whenever the fresh render had fewer slots (e.g. a run that produced
 * zero highlights) and mis-attached them whenever highlights shifted.
 *
 * This module re-attaches each note to its ANCHOR — the content lines directly
 * above the block (the highlight blockquote, the page-image embed, or the
 * `### Page N` header) — normalized so re-rendered image hashes don't break
 * the match. Any note that cannot be matched is never dropped: it is appended
 * to the end of the managed section under a "Preserved notes" callout with its
 * original context, for the user to re-place.
 */

import {
  findHighlightsStart,
  findHighlightsEnd,
} from '../plugin/highlight-markers';

const NOTES_BLOCK_RE = /<!-- notes -->([\s\S]*?)<!-- \/notes -->/g;

/**
 * Lines that delimit structure rather than content: section markers (current
 * and legacy styles) and notes-block markers. They must never be part of an
 * anchor — a highlight that sits directly after the start marker would
 * otherwise get a different anchor in a legacy-marker note than in a fresh
 * render, and consecutive notes blocks would anchor to each other.
 */
function isStructuralMarker(line: string): boolean {
  return /^<!--\s*(\/?notes|(remarkable-bridge|eink-sync):(start|end))\s*-->$/.test(line.trim());
}

interface AnchoredNote {
  /** Normalized anchor key used for matching. */
  key: string;
  /** Original (un-normalized) anchor lines, for orphan context. */
  anchorText: string;
  /** The user's typed content (trimmed; empty string when the slot was unused). */
  content: string;
}

/**
 * Normalize an anchor so cosmetic render differences don't break matching:
 * page-image filenames embed a content hash that changes on re-render
 * (`Name_p3_a4af.png` -> `Name_p3_b2c1.png`), and embed size aliases
 * (`|900`) are presentation-only.
 */
function normalizeAnchor(text: string): string {
  return text
    .replace(/_p(\d+)_[0-9a-f]+\.(png|svg|jpg|jpeg)/gi, '_p$1.$2')
    .replace(/\|[^\]]*\]\]/g, ']]')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Extract every notes block in a managed section together with its anchor:
 * the contiguous run of non-empty lines immediately above the block.
 */
function extractAnchoredNotes(section: string): AnchoredNote[] {
  const found: AnchoredNote[] = [];
  NOTES_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = NOTES_BLOCK_RE.exec(section)) !== null) {
    const before = section.substring(0, match.index);
    const lines = before.split('\n');
    // Drop trailing blank lines, then collect the contiguous non-empty run,
    // stopping at structural markers.
    let i = lines.length - 1;
    while (i >= 0 && lines[i].trim() === '') i--;
    const anchorLines: string[] = [];
    while (i >= 0 && lines[i].trim() !== '' && !isStructuralMarker(lines[i])) {
      anchorLines.unshift(lines[i]);
      i--;
    }
    const anchorText = anchorLines.join('\n');
    found.push({
      key: normalizeAnchor(anchorText) || '__section-start__',
      anchorText,
      content: match[1].trim(),
    });
  }
  return found;
}

/** First line of an anchor, shortened for the orphan callout context. */
function anchorSummary(anchorText: string): string {
  const first = anchorText.split('\n')[0]?.trim() ?? '';
  return first.length > 100 ? first.slice(0, 100) + '…' : first;
}

/**
 * Render orphaned notes (whose anchors no longer exist) as an appendix that
 * keeps them inside the managed section, visible, and still editable.
 */
function renderOrphanAppendix(orphans: AnchoredNote[]): string {
  const parts: string[] = [
    '> [!warning] Preserved notes',
    '> These typed notes could not be matched to their original position after re-extraction. Move them where they belong; they will keep being preserved here until then.',
    '',
  ];
  for (const orphan of orphans) {
    if (orphan.anchorText) {
      parts.push(`**Originally under:** \`${anchorSummary(orphan.anchorText)}\``);
    }
    parts.push('<!-- notes -->', orphan.content, '<!-- /notes -->', '');
  }
  return parts.join('\n');
}

/**
 * Carry every typed note from `existingContent` into `newContent`.
 *
 * Both inputs are full note files; the managed section is located via the
 * marker pairs (current or legacy). Empty slots in the new section are filled
 * by anchor match (duplicate anchors match in order); notes with no matching
 * slot are appended to the section as a "Preserved notes" callout. The
 * function guarantees no non-empty note content is ever lost.
 */
export function preserveTypedNotes(
  existingContent: string,
  newContent: string,
): string {
  const oldStart = findHighlightsStart(existingContent);
  const oldEnd = findHighlightsEnd(existingContent);
  if (!oldStart || !oldEnd) return newContent;

  const oldSection = existingContent.substring(
    oldStart.index, oldEnd.index + oldEnd.marker.length,
  );
  const preserved = extractAnchoredNotes(oldSection).filter((n) => n.content !== '');
  if (preserved.length === 0) return newContent;

  const newStart = findHighlightsStart(newContent);
  const newEnd = findHighlightsEnd(newContent);
  if (!newStart || !newEnd) {
    // No managed section in the new content at all — never drop the notes.
    return newContent.trimEnd() + '\n\n' + renderOrphanAppendix(preserved) + '\n';
  }

  let newSection = newContent.substring(
    newStart.index, newEnd.index + newEnd.marker.length,
  );

  // Queue preserved notes per anchor key so duplicate anchors fill in order.
  const byKey = new Map<string, AnchoredNote[]>();
  for (const note of preserved) {
    const queue = byKey.get(note.key);
    if (queue) queue.push(note);
    else byKey.set(note.key, [note]);
  }

  // Fill matching empty slots in the new section.
  const newAnchored = extractAnchoredNotes(newSection);
  let slotIdx = 0;
  NOTES_BLOCK_RE.lastIndex = 0;
  newSection = newSection.replace(NOTES_BLOCK_RE, (whole, existingInner: string) => {
    const slot = newAnchored[slotIdx++];
    const queue = slot ? byKey.get(slot.key) : undefined;
    if (existingInner.trim() !== '') {
      // Slot already carries content (e.g. the helper ran twice over the same
      // pair): consume an identical preserved note so it is not duplicated
      // into the orphan appendix.
      if (queue && queue.length > 0 && queue[0].content === existingInner.trim()) {
        queue.shift();
      }
      return whole;
    }
    const note = queue?.shift();
    if (!note) return whole;
    return `<!-- notes -->\n${note.content}\n<!-- /notes -->`;
  });

  // Anything left in the queues has no home in the new section — append it.
  const orphans: AnchoredNote[] = [];
  for (const queue of byKey.values()) orphans.push(...queue);
  if (orphans.length > 0) {
    const endMarkerIdx = newSection.lastIndexOf(newEnd.marker);
    newSection =
      newSection.substring(0, endMarkerIdx).trimEnd() +
      '\n\n' + renderOrphanAppendix(orphans) + '\n' +
      newSection.substring(endMarkerIdx);
  }

  return (
    newContent.substring(0, newStart.index) +
    newSection +
    newContent.substring(newEnd.index + newEnd.marker.length)
  );
}
