import assert from 'node:assert/strict';
import { DEFAULT_TUNING } from '@effortlessmotion/pdf-to-md';

// Word-height range within one printed line: x-height-only (~0.011) through ascender+descender
// (~0.019) — measured ratio up to ~2.2, why lineHeightRatio 1.6 under-merges real same-line words.
const LINE_HEIGHT_WORD_RATIO_MEASURED_MAX = 2.2;

// Pair-F1 by lineHeightRatio, swept over baseline-doc pp10/27/57/82 (9,471 same-line word pairs):
// flat through 2.8, dips by 3.5 — 2.4 is the plateau edge with margin.
const PAIR_F1_BY_LINE_HEIGHT_RATIO: Record<number, number> = { 1.6: 0.924, 2.4: 0.995 };

describe('DEFAULT_TUNING.lineHeightRatio: pair-F1 sweep derivation', () => {
  it('2.4 is the plateau edge (F1 0.995), well above 1.6 (F1 0.924), and clears the measured word-height ratio', () => {
    assert.equal(DEFAULT_TUNING.lineHeightRatio, 2.4);
    assert.ok(PAIR_F1_BY_LINE_HEIGHT_RATIO[2.4] > PAIR_F1_BY_LINE_HEIGHT_RATIO[1.6]);
    assert.ok(PAIR_F1_BY_LINE_HEIGHT_RATIO[2.4] >= 0.99, 'plateau edge should be near-perfect pair-F1');
    assert.ok(DEFAULT_TUNING.lineHeightRatio > LINE_HEIGHT_WORD_RATIO_MEASURED_MAX, '2.4 clears the measured within-line word-height ratio with margin');
  });
});
