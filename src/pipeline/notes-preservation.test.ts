/**
 * Tests for notes-preservation.ts — typed user notes must survive every
 * regeneration of the managed section, including the exact failure modes
 * that destroyed real notes: a fresh render with zero (or fewer) notes
 * slots, shifted highlight order, and re-rendered image filenames.
 */

import { preserveTypedNotes } from './notes-preservation';

const S = '<!-- remarkable-bridge:start -->';
const E = '<!-- remarkable-bridge:end -->';

function noteFile(section: string): string {
  return `---\ntitle: "T"\n---\n\n${S}\n${section}\n${E}\n`;
}

const filled = (content: string) => `<!-- notes -->\n${content}\n<!-- /notes -->`;
const empty = '<!-- notes -->\n<!-- /notes -->';

describe('preserveTypedNotes', () => {
  it('carries a note to the matching highlight in the new render', () => {
    const existing = noteFile(
      `### Page 3\n\n${empty}\n\n> Attention is all you need\n> -- [[a.pdf#page=3|Page 3]]\n${filled('my insight')}\n`,
    );
    const fresh = noteFile(
      `### Page 3\n\n${empty}\n\n> Attention is all you need\n> -- [[a.pdf#page=3|Page 3]]\n${empty}\n`,
    );

    const result = preserveTypedNotes(existing, fresh);

    expect(result).toContain('my insight');
    expect(result).not.toContain('Preserved notes');
  });

  it('keeps the note on its own highlight when a new one is inserted above (positional logic would shift it)', () => {
    const existing = noteFile(
      `> old highlight\n> -- [[a.pdf#page=2|Page 2]]\n${filled('note on OLD')}\n`,
    );
    const fresh = noteFile(
      `> brand new highlight\n> -- [[a.pdf#page=1|Page 1]]\n${empty}\n\n> old highlight\n> -- [[a.pdf#page=2|Page 2]]\n${empty}\n`,
    );

    const result = preserveTypedNotes(existing, fresh);

    const newIdx = result.indexOf('brand new highlight');
    const noteIdx = result.indexOf('note on OLD');
    const oldIdx = result.indexOf('> old highlight');
    expect(noteIdx).toBeGreaterThan(oldIdx);
    expect(oldIdx).toBeGreaterThan(newIdx);
    expect(result).not.toContain('Preserved notes');
  });

  it('survives a re-rendered image filename hash', () => {
    const existing = noteFile(
      `### Page 1\n\n${empty}\n\n![[Linear algebra_p1_9e31.png|900]]\n${filled('page one note')}\n`,
    );
    const fresh = noteFile(
      `### Page 1\n\n${empty}\n\n![[Linear algebra_p1_ab42.png|900]]\n${empty}\n`,
    );

    const result = preserveTypedNotes(existing, fresh);

    expect(result).toContain('page one note');
    expect(result).toContain('Linear algebra_p1_ab42.png');
    expect(result).not.toContain('Preserved notes');
  });

  it('never drops notes when the fresh render has ZERO slots (the empty-stub clobber)', () => {
    const existing = noteFile(
      `> some highlight\n> -- [[a.pdf#page=5|Page 5]]\n${filled('precious thought')}\n`,
    );
    const fresh = noteFile('_No highlights or annotations found._');

    const result = preserveTypedNotes(existing, fresh);

    expect(result).toContain('precious thought');
    expect(result).toContain('Preserved notes');
    expect(result).toContain('some highlight'); // anchor context survives
    // The appendix stays inside the managed section.
    expect(result.indexOf('precious thought')).toBeLessThan(result.indexOf(E));
  });

  it('appends unmatched notes as an appendix instead of dropping them', () => {
    const existing = noteFile(
      `> vanished highlight\n> -- [[a.pdf#page=9|Page 9]]\n${filled('orphan note')}\n\n> kept highlight\n> -- [[a.pdf#page=1|Page 1]]\n${filled('kept note')}\n`,
    );
    const fresh = noteFile(
      `> kept highlight\n> -- [[a.pdf#page=1|Page 1]]\n${empty}\n`,
    );

    const result = preserveTypedNotes(existing, fresh);

    expect(result).toContain('kept note');
    expect(result).toContain('orphan note');
    expect(result).toContain('Preserved notes');
    expect(result).toContain('vanished highlight');
  });

  it('fills duplicate anchors in order', () => {
    const dup = `> same text\n> -- [[a.pdf#page=1|Page 1]]`;
    const existing = noteFile(`${dup}\n${filled('first')}\n\n${dup}\n${filled('second')}\n`);
    const fresh = noteFile(`${dup}\n${empty}\n\n${dup}\n${empty}\n`);

    const result = preserveTypedNotes(existing, fresh);

    expect(result.indexOf('first')).toBeGreaterThan(-1);
    expect(result.indexOf('second')).toBeGreaterThan(result.indexOf('first'));
    expect(result).not.toContain('Preserved notes');
  });

  it('is idempotent when applied twice over the same pair', () => {
    const existing = noteFile(
      `> h\n> -- [[a.pdf#page=1|Page 1]]\n${filled('once only')}\n`,
    );
    const fresh = noteFile(`> h\n> -- [[a.pdf#page=1|Page 1]]\n${empty}\n`);

    const once = preserveTypedNotes(existing, fresh);
    const twice = preserveTypedNotes(existing, once);

    expect(twice).toBe(once);
    expect(twice.match(/once only/g)).toHaveLength(1);
  });

  it('handles mixed marker styles (legacy existing, current fresh)', () => {
    const existing = noteFile(
      `> h\n> -- [[a.pdf#page=1|Page 1]]\n${filled('legacy note')}\n`,
    );
    const fresh = `---\ntitle: "T"\n---\n\n<!-- eink-sync:start -->\n> h\n> -- [[a.pdf#page=1|Page 1]]\n${empty}\n<!-- eink-sync:end -->\n`;

    const result = preserveTypedNotes(existing, fresh);

    expect(result).toContain('legacy note');
  });

  it('leaves content untouched when the existing note has no typed notes', () => {
    const existing = noteFile(`> h\n> -- [[a.pdf#page=1|Page 1]]\n${empty}\n`);
    const fresh = noteFile(`> other\n> -- [[a.pdf#page=2|Page 2]]\n${empty}\n`);

    expect(preserveTypedNotes(existing, fresh)).toBe(fresh);
  });

  it('appends notes at the end of the file when the new content has no managed section', () => {
    const existing = noteFile(`> h\n> -- [[a.pdf#page=1|Page 1]]\n${filled('rescue me')}\n`);
    const fresh = '---\ntitle: "T"\n---\n\nplain content, no markers\n';

    const result = preserveTypedNotes(existing, fresh);

    expect(result).toContain('rescue me');
    expect(result).toContain('Preserved notes');
  });
});
