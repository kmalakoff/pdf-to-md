// tuning.test.ts — OCR-path heuristics (src/geometry.ts's Tuning interface) are overridable via
// --flag=value; see DEFAULT_TUNING's comment for what each knob controls. Checks only: defaults unchanged with no flags, a flag demonstrably changes behavior, a bad value is a usage error.

import assert from 'node:assert/strict';
import { DEFAULT_TUNING } from '@effortlessmotion/pdf-to-md';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

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

describe('tuning: defaults unchanged when no flags are passed', () => {
  it('ocr-badge.pdf: badge still floats, heading still detected, paragraphs still joined', () => {
    const result = run([fixturePath('ocr-badge.pdf'), '--stdout', '--ocr', '--json']);
    const report = expectReport(result);
    const { md } = result;
    assert.equal(report.floats, 1);
    assert.match(md, /^#+\s*Trail Guide\s*$/im);
    assert.match(md, /Campers followed the marked trail past the old stone bridge today\.?/i);
  });

  it('ocr-single.pdf: heading still detected, paragraphs still joined', () => {
    const result = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--json']);
    const report = expectReport(result);
    const { md } = result;
    assert.equal(report.headings, 1);
    assert.match(md, /^#+\s*Mountain Journal\s*$/im);
    assert.match(md, /valley stretched beneath the morning clouds and pine trees\.?/i);
  });
});

describe('tuning: a flag demonstrably changes behavior', () => {
  it('--float-max-words=0 on ocr-badge.pdf: the badge is no longer floated', () => {
    const report = expectReport(run([fixturePath('ocr-badge.pdf'), '--stdout', '--ocr', '--json', '--float-max-words=0']));
    assert.equal(report.floats, 0, 'badge fragment should fail the word-count check and land in body flow instead');
  });

  it('--heading-scale=99 on ocr-single.pdf: no heading-size line clears the (absurdly high) bar', () => {
    const report = expectReport(run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--json', '--heading-scale=99']));
    assert.equal(report.headings, 0);
  });
});

describe('tuning: an invalid value is a usage error, not silently ignored', () => {
  it('--para-gap=abc (non-numeric) exits nonzero with a usage message on stderr', () => {
    const { status, stderr } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--para-gap=abc']);
    assert.notEqual(status, 0);
    assert.match(stderr, /usage:/i);
    assert.match(stderr, /--para-gap/);
  });

  it('--float-margin=-1 (<= 0) exits nonzero with a usage message on stderr', () => {
    const { status, stderr } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--float-margin=-1']);
    assert.notEqual(status, 0);
    assert.match(stderr, /usage:/i);
    assert.match(stderr, /--float-margin/);
  });

  it('--dpi=abc (non-numeric) exits nonzero with a usage message on stderr', () => {
    const { status, stderr } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--dpi=abc']);
    assert.notEqual(status, 0);
    assert.match(stderr, /usage:/i);
    assert.match(stderr, /--dpi/);
  });

  it('--dpi=-5 (<= 0) exits nonzero with a usage message on stderr', () => {
    const { status, stderr } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--dpi=-5']);
    assert.notEqual(status, 0);
    assert.match(stderr, /usage:/i);
    assert.match(stderr, /--dpi/);
  });
});

// --dpi threads through to src/engines/tesseract.ts's OCR_RENDER_DPI (default 288); 100 is
// comfortably below default but well above where recognition degrades (empirically well under 30 on this fixture), so the test isn't a flaky bet on the exact falloff point.
describe('--dpi: overrides the default OCR render resolution', () => {
  it('ocr-single.pdf --dpi=100 still recognizes the fixture heading', () => {
    const { md, status } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--dpi=100']);
    assert.equal(status, 0);
    assert.match(md, /Mountain Journal/i);
  });
});
