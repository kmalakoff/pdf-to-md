// Pass 2: glyphs -> visual lines — de-braids two-column pages (spanning
// lines like headings sort with the left column), joins words by measured horizontal gap, and folds typographic codepoints to ASCII so search doesn't miss half the hits.
import type { CollectedPage, Glyph, Line } from './types.ts';

const FOLD: Record<string, string> = {
  ʼ: "'",
  '’': "'",
  '‘': "'",
  '“': '"',
  '”': '"',
  '–': '-',
};
// Exported for the OCR engine seam (src/engines/tesseract.ts): both paths
// must fold identically or the same printed apostrophe surfaces as two spellings depending on which path read the page.
export const foldTypographic = (s: string): string => s.replace(/[ʼ‘’“”–]/g, (c) => FOLD[c]);
const normalize = foldTypographic;

// Intermediate row while grouping glyphs by visual line, before the final
// text/height reduction below.
interface LineDraft {
  col: number;
  y: number;
  parts: Array<{ glyph: Glyph; index: number }>;
}

export function toLines({ glyphs, width }: Pick<CollectedPage, 'glyphs' | 'width'>): Line[] {
  if (!glyphs.length) return [];

  const mid = width / 2;
  // A real two-column page has a gutter: clusters each side, almost nothing crossing mid.
  // Label/value layouts also cluster but their values cross mid — de-braiding would reorder them.
  const twoCol = glyphs.filter((g) => g.x + g.w < mid).length > glyphs.length * 0.25 && glyphs.filter((g) => g.x > mid).length > glyphs.length * 0.25 && glyphs.filter((g) => g.x < mid && g.x + g.w > mid).length < glyphs.length * 0.15;

  // Group on y with a tolerance that scales with font size.
  const lines: LineDraft[] = [];
  const indexedGlyphs = glyphs.map((glyph, index) => ({ glyph, index }));
  for (const part of indexedGlyphs.sort((a, b) => a.glyph.y - b.glyph.y || a.glyph.x - b.glyph.x)) {
    const { glyph: g } = part;
    // NOTE: start-x assignment can misfile a gutter-straddling glyph; an
    // overlap-based alternative was tried and reshuffled stray numerals with
    // no measured win, so start-x stays (src/geometry.ts's OCR path assigns by x-span overlap instead, where the mis-assignment is measured).
    const col = twoCol && g.x > mid ? 1 : 0;
    const last = lines.at(-1);
    if (last && last.col === col && Math.abs(last.y - g.y) < Math.max(2, g.h * 0.5)) {
      last.parts.push(part);
      last.y = (last.y + g.y) / 2;
    } else lines.push({ col, y: g.y, parts: [part] });
  }
  lines.sort((a, b) => a.col - b.col || a.y - b.y); // column, then down the page

  return lines
    .map((l): Line => {
      const parts = l.parts.sort((a, b) => a.glyph.x - b.glyph.x);
      let t = '';
      let prev: Glyph | null = null;
      for (const { glyph: cur } of parts) {
        // insert a space when the measured gap is wider than intra-word kerning
        if (prev && cur.x - (prev.x + prev.w) > prev.h * 0.12 && !/\s$/.test(t) && !/^\s/.test(cur.s)) t += ' ';
        t += cur.s;
        prev = cur;
      }
      // Line height = the char-weighted dominant height, not the max: a small
      // decorative large-face numeral must not promote a body line to a heading.
      const byH = new Map<number, number>();
      for (const { glyph: p } of parts) byH.set(p.h, (byH.get(p.h) || 0) + p.s.length);
      return {
        text: normalize(t).replace(/\s+/g, ' ').trim(),
        x: parts[0].glyph.x,
        y: l.y,
        h: [...byH.entries()].sort((a, b) => b[1] - a[1])[0][0],
        col: l.col,
        wordIndexes: parts.map(({ index }) => index),
      };
    })
    .filter((l) => l.text);
}
