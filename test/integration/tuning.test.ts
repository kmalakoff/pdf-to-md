// tuning.test.ts — CLI tuning overrides exercised through real OCR fixtures.

import assert from 'node:assert/strict';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

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
