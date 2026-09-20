import assert from 'assert';
import { toLines } from '../../src/lines.ts';
import type { CollectedPage } from '../../src/types.ts';

describe('toLines(): source glyph indexes', () => {
  it('returns original glyph indexes in the same left-to-right order as emitted text', () => {
    const page: CollectedPage = {
      page: 1,
      glyphs: [
        { s: 'Right', x: 220, y: 100, w: 30, h: 12, bounds: { x: 220, y: 88, w: 30, h: 12 } },
        { s: 'Middle', x: 140, y: 100, w: 35, h: 12, bounds: { x: 140, y: 88, w: 35, h: 12 } },
        { s: 'Left', x: 72, y: 100, w: 25, h: 12, bounds: { x: 72, y: 88, w: 25, h: 12 } },
      ],
      width: 612,
      height: 792,
      textChars: 15,
      hasImage: false,
      largeImage: false,
    };

    const lines = toLines(page);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].text, 'Left Middle Right');
    assert.deepEqual(lines[0].wordIndexes, [2, 1, 0]);
    assert.deepEqual(
      lines[0].wordIndexes.map((index) => page.glyphs[index].s),
      ['Left', 'Middle', 'Right']
    );
  });
});
