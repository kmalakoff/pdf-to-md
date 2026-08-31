// centered.test.ts — fixture 6: a centered paragraph's short last line must
// stay in body, not get misclassified as a float. Rescue mechanism: src/geometry.ts's float pass (paragraph-adjacency check).

import assert from 'node:assert/strict';
import { fixturePath } from '../lib/fixtures.ts';
import { run } from '../lib/run.ts';

describe('OCR path: ocr-centered.pdf (centered-paragraph float classification)', () => {
  const { md } = run([fixturePath('ocr-centered.pdf'), '--stdout', '--ocr']);

  it('keeps a centered paragraph\'s short last line in the body, not "> [floats]"', () => {
    assert.match(md, /The quiet valley stretched for miles at dusk\.?/i);
    assert.match(md, /Travelers rested beside the river and rest\.?/i);
    assert.doesNotMatch(md, /^>\s*\[floats\]/im);
  });
});
