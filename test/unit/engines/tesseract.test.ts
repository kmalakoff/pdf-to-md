// engines/tesseract.test.ts — the adaptive chart-page second pass (src/engines/tesseract.ts): when a
// page's "prose fraction" (share of recognized words with a run of 3+ letters) drops below 0.6, re-recognizing the same PNG with PSM.SPARSE_TEXT measurably rescues it.

// Unit-tests the pure decision (`shouldRetrySparse`) directly, engine-independent. Full measured
// numbers live in this file, not in the source comment.

import assert from 'node:assert/strict';
import { SPARSE_RETRY_PROSE_FRACTION, shouldRetrySparse } from '../../../src/engines/tesseract.ts';
import { fixturePath } from '../../lib/fixtures.ts';
import { expectReport, run } from '../../lib/run.ts';

// Real p4 (chart page), PSM.AUTO vs PSM.SPARSE_TEXT, at OCR_RENDER_DPI
// (288): word count and recall against a 94-word ground truth.
const P4_CHART_PAGE_288DPI = {
  auto: { words: 52, recallPct: 35.1 },
  sparseText: { words: 82, recallPct: 54.3 },
};

// Same page at 600dpi: higher resolution rescues nothing and costs
// recognition time — both passes score WORSE than at 288dpi.
const P4_CHART_PAGE_600DPI_RECALL_PCT = { auto: 23.4, sparseText: 53.2 };

// Per-page prose fraction under PSM.AUTO, real document: the chart page
// (p4) sits far below every ordinary page sampled.
const MEASURED_PROSE_FRACTION = { p4Chart: 0.442, p5: 0.767, p10: 0.775, p27: 0.819, p57: 0.78, p82: 0.774, p100: 0.938 };

describe('sparse-retry measured numbers (src/engines/tesseract.ts)', () => {
  it('SPARSE_TEXT recognizes more words and recalls better than AUTO on the chart page, both dpi', () => {
    assert.ok(P4_CHART_PAGE_288DPI.sparseText.words > P4_CHART_PAGE_288DPI.auto.words);
    assert.ok(P4_CHART_PAGE_288DPI.sparseText.recallPct > P4_CHART_PAGE_288DPI.auto.recallPct);
    assert.ok(P4_CHART_PAGE_600DPI_RECALL_PCT.sparseText > P4_CHART_PAGE_600DPI_RECALL_PCT.auto);
  });

  it('600dpi is not better than 288dpi for either pass (higher dpi rescues nothing)', () => {
    assert.ok(P4_CHART_PAGE_600DPI_RECALL_PCT.auto < P4_CHART_PAGE_288DPI.auto.recallPct);
    assert.ok(P4_CHART_PAGE_600DPI_RECALL_PCT.sparseText < P4_CHART_PAGE_288DPI.sparseText.recallPct);
  });

  it('the chart page prose fraction sits below every ordinary page, with the real threshold between', () => {
    const ordinaryFractions = [MEASURED_PROSE_FRACTION.p5, MEASURED_PROSE_FRACTION.p10, MEASURED_PROSE_FRACTION.p27, MEASURED_PROSE_FRACTION.p57, MEASURED_PROSE_FRACTION.p82, MEASURED_PROSE_FRACTION.p100];
    assert.ok(MEASURED_PROSE_FRACTION.p4Chart < SPARSE_RETRY_PROSE_FRACTION);
    assert.ok(SPARSE_RETRY_PROSE_FRACTION < Math.min(...ordinaryFractions));
  });
});

// Fixture composition mirrors the measured real-document split (chart page 0.442, ordinary
// pages 0.767-0.938): these synthetic word lists sit on the same sides of the measured bimodal gap, not just past the 0.6 cut line.

/** Numeral-only "words" (no run of 3+ letters) — the chart-scatter shape (reference numbers around a chart diagram). */
const numerals = ['1.3', '13.1', '47', '24.6', '56.6', '31.4', '20.5', '9.2', '44', '17.8'].map((text) => ({ text }));

/** Ordinary-prose words (each has a run of 3+ letters) — an unremarkable body-text line. */
const proseWords = 'the quiet harbor filled slowly with morning light and gulls circling overhead'.split(' ').map((text) => ({ text }));

describe('shouldRetrySparse (src/engines/tesseract.ts)', () => {
  it('exports the measured threshold, 0.6', () => {
    assert.equal(SPARSE_RETRY_PROSE_FRACTION, 0.6);
  });

  it('returns true for a numeral-dominated word list (prose fraction 0 < 0.6, the p4 chart-page shape)', () => {
    assert.equal(shouldRetrySparse(numerals), true);
  });

  it('returns false for an ordinary prose word list (prose fraction 1.0, the p5-p100 ordinary-page shape)', () => {
    assert.equal(shouldRetrySparse(proseWords), false);
  });

  it('returns false for an empty word list (no retry on a blank page)', () => {
    assert.equal(shouldRetrySparse([]), false);
  });

  it('returns true for a page mixing prose and numerals below the threshold (mirrors the real p4 prose fraction, 0.442)', () => {
    // 4 prose-shaped words + 5 numeral words = 4/9 = 0.444, matching the
    // real measured p4 value (0.442) within rounding.
    const mixed = [...'gate strategy authority profile'.split(' ').map((text) => ({ text })), ...numerals.slice(0, 5)];
    assert.equal(mixed.length, 9);
    assert.equal(shouldRetrySparse(mixed), true);
  });

  it('returns false right at the threshold (0.6 is excluded, not included) and true just below it', () => {
    // 6 prose + 4 numeral = 0.6 exactly -> must NOT retry (strict <).
    const atThreshold = [...'quiet harbor filled slowly with morning'.split(' ').map((text) => ({ text })), ...numerals.slice(0, 4)];
    assert.equal(atThreshold.length, 10);
    assert.equal(shouldRetrySparse(atThreshold), false);

    // 5 prose + 5 numeral = 0.5 < 0.6 -> must retry.
    const belowThreshold = [...'quiet harbor filled slowly morning'.split(' ').map((text) => ({ text })), ...numerals.slice(0, 5)];
    assert.equal(belowThreshold.length, 10);
    assert.equal(shouldRetrySparse(belowThreshold), true);
  });

  it('returns false for a thin, title-ish page (few words, all prose-shaped) — the p100 false-positive risk (0.938 measured)', () => {
    // A short title line is exactly the shape that must NOT trigger a
    // retry: few words, but every one of them prose-shaped.
    assert.equal(shouldRetrySparse([{ text: 'Conclusion' }]), false);
  });
});

// End-to-end "must not over-trigger" control: ocr-chart.pdf (fixture 11) measures 51 words,
// prose fraction 0.510 (below the 0.6 threshold, so the retry fires), but PSM.SPARSE_TEXT ties
// PSM.AUTO's word count (51 == 51), so AUTO is kept, no diagnostic emitted, output unchanged.
describe('OCR path: ocr-chart.pdf — retry attempted but ties (must-not-over-trigger control)', () => {
  it('does not emit a sparse-retry diagnostic (AUTO and SPARSE_TEXT tie on word count)', () => {
    const { stderr } = run([fixturePath('ocr-chart.pdf'), '--stdout', '--ocr']);
    assert.doesNotMatch(stderr, /retried with sparse-text segmentation/);
  });
});

// ocr-chart-only.pdf (fixture 12) is denser than ocr-chart.pdf's scatter and has NO prose at
// all, which measurably makes PSM.AUTO under-recognize it — the positive end-to-end case: retry must fire AND win.
describe('OCR path: ocr-chart-only.pdf (numerals only, no prose — the retry must fire AND win)', () => {
  const result = run([fixturePath('ocr-chart-only.pdf'), '--stdout', '--ocr', '--json']);
  const report = expectReport(result);
  const { md, stderr } = result;

  it('emits the sparse-retry diagnostic, in the documented format, with SPARSE_TEXT finding more words than AUTO', () => {
    const match = stderr.match(/p1: chart-like page \(prose fraction ([\d.]+)\) — retried with sparse-text segmentation, (\d+) -> (\d+) words/);
    assert.ok(match, `expected a sparse-retry diagnostic line on stderr, got:\n${stderr}`);
    const [, fraction, autoWords, sparseWords] = match as unknown as [string, string, string, string];
    assert.ok(Number(fraction) < SPARSE_RETRY_PROSE_FRACTION, `expected prose fraction < ${SPARSE_RETRY_PROSE_FRACTION}, got ${fraction}`);
    assert.ok(Number(sparseWords) > Number(autoWords), `expected the sparse pass to win, got ${autoWords} -> ${sparseWords}`);
  });

  it('recognizes all 40 numerals (the sparse pass, not the under-recognizing auto pass, wins)', () => {
    for (const n of ['1.3', '13.1', '56.6', '31.4', '9.2', '2.3', '41.4', '28', '50.1', '61', '22.7', '15.4', '36.6', '52', '39.1', '1.6', '59']) {
      const needle = new RegExp(`(^|\\s)${n.replace('.', '\\.')}(\\s|$)`);
      assert.ok(needle.test(md), `expected numeral "${n}" in the recognized output`);
    }
  });

  it('marks the scatter as a review block (no reading order to infer, same as the real chart page)', () => {
    assert.match(md, /^> \[review: unstructured labels\]/m);
    assert.equal(report.junkHeadings, 0);
    assert.ok(report.reviewBlocks >= 1);
  });
});
