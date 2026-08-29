// review-blocks.test.ts — explicit "needs manual review" markers for regions where the geometry
// can't infer reading order (README's "Design contract"): keeps such regions visible/machine-detectable (severity-3) instead of silently reading as normal prose, while preserving every word.

// Two levels: fixture-level (ocr-chart.pdf, modeled on test/lib/make-fixtures.ts's fixture 11,
// full engine path) and geometry-level (--words-json, engine-independent, same pattern as column-break.test.ts's geometry-only cases).

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { UNSTRUCTURED_WORDLIKE_FRACTION } from '../../src/emit.ts';
import { LOW_CONFIDENCE_THRESHOLD } from '../../src/report.ts';
import { debugWordsPath, readDebugWords } from '../lib/debug-words.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

describe('OCR path: ocr-chart.pdf (review markers on a chart-page scatter)', () => {
  const dump = debugWordsPath();
  const result = run([fixturePath('ocr-chart.pdf'), '--stdout', '--ocr', '--json', `--debug-words=${dump}`]);
  const report = expectReport(result);
  const { md } = result;

  it('marks the scattered numerals as a review block, in the documented format', () => {
    const reviewLines = md.split('\n').filter((l) => l.startsWith('> [review: unstructured labels]'));
    assert.ok(reviewLines.length >= 1, 'expected at least one "> [review: unstructured labels]" line');
    // The numerals from the scatter (test/lib/make-fixtures.ts's fixture 11)
    // must be inside it, not dropped or relocated elsewhere.
    const joined = reviewLines.join('\n');
    for (const n of ['1.3', '13.1', '47', '24.6', '56.6', '31.4', '9.2', '38.9', '50.1']) {
      assert.ok(joined.includes(n), `expected numeral "${n}" inside the review line`);
    }
  });

  it('leaves the ordinary prose paragraph as a NORMAL paragraph (no review marker, no floats)', () => {
    assert.match(md, /^This chart summarizes how a person tends to make decisions and interact with the people around them over the course of an ordinary day\.?$/m);
    assert.doesNotMatch(md, />\s*\[review:[^\]]*\][^\n]*chart summarizes/i);
    assert.doesNotMatch(md, /^>\s*\[floats\].*chart summarizes/im);
  });

  it('leaves the label/value pairs unmarked (real words, not a review block)', () => {
    assert.match(md, /STRATEGY/);
    assert.match(md, /To Respond/);
    assert.match(md, /AUTHORITY/);
    assert.match(md, /Sacral/);
    assert.doesNotMatch(md, />\s*\[review:[^\]]*\][^\n]*STRATEGY/i);
    assert.doesNotMatch(md, />\s*\[review:[^\]]*\][^\n]*AUTHORITY/i);
  });

  it('counts the review block in the QA report, at both the document and page level', () => {
    assert.ok(report.reviewBlocks >= 1, `expected report.reviewBlocks >= 1, got ${report.reviewBlocks}`);
    assert.ok(report.pageStats[0].reviewBlocks >= 1, `expected pageStats[0].reviewBlocks >= 1, got ${report.pageStats[0].reviewBlocks}`);
  });

  it('reports 0 junk headings (the scatter is a review block, not a heading)', () => {
    assert.equal(report.junkHeadings, 0);
  });

  // Severity-1: the review marker must PRESERVE every word, not just visibly flag the block —
  // same mechanism as no-silent-loss.test.ts, run against this fixture.
  it('drops no engine-recognized word (severity-1: no silent loss)', () => {
    const words = readDebugWords(dump).map((w) => w.text);
    assert.ok(words.length > 0, '--debug-words produced no words — engine or flag broken');
    const haystack = normalize(md);
    const missing: string[] = [];
    for (const w of words) {
      const needle = normalize(w);
      if (!needle) continue;
      if (!haystack.includes(needle)) missing.push(w);
    }
    assert.deepEqual(missing, [], `words recognized by the engine but missing from ocr-chart.pdf's markdown output: ${JSON.stringify(missing)}`);
  });
});

// Geometry-level case via --words-json: a pure-numeral block fed straight into the geometry,
// same --words-json pattern as column-break.test.ts's geometry-only cases.

interface DumpWord {
  page: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Lay one visual line of words: fixed per-word width + gap, shared y/h. */
function dumpLine(page: number, y: number, xStart: number, text: string, h = 0.017): DumpWord[] {
  const words = text.split(' ');
  const step = 0.062;
  return words.map((t, i) => ({
    page,
    text: t,
    x: xStart + i * step,
    y,
    w: 0.052,
    h,
  }));
}

function runWordsJson(words: DumpWord[]): ReturnType<typeof run> {
  const dir = scratchDir('review-blocks-words-');
  const file = path.join(dir, 'words.jsonl');
  writeFileSync(file, words.map((w) => JSON.stringify(w)).join('\n'));
  return run([`--words-json=${file}`, '--stdout', '--ocr', '--json']);
}

describe('review marker via a constructed word dump (--words-json)', () => {
  // A pure-numeral block beside an ordinary prose paragraph, well separated vertically so they
  // land in different blocks (mirrors ocr-chart.pdf's layout at the geometry level).
  const chartLikePage: DumpWord[] = [...dumpLine(1, 0.85, 0.1, '4.1 27 9.3 51.6 12'), ...dumpLine(1, 0.82, 0.1, '33.4 6 44.2 19 8.7'), ...dumpLine(1, 0.5, 0.1, 'The quiet harbor filled slowly'), ...dumpLine(1, 0.475, 0.1, 'with morning light and gulls.')];

  it('returns a pure-numeral block as a review line, unlike the prose beside it', () => {
    const result = runWordsJson(chartLikePage);
    const report = expectReport(result);
    const { md } = result;
    assert.match(md, /^> \[review: unstructured labels\] 4\.1 27 9\.3 51\.6 12 33\.4 6 44\.2 19 8\.7$/m);
    assert.doesNotMatch(md, />\s*\[review:[^\]]*\][^\n]*quiet harbor/i);
    assert.match(md, /^The quiet harbor filled slowly with morning light and gulls\.?$/m);
    assert.ok(report.reviewBlocks >= 1);
  });
});

// Regression: isUnstructured is a FRACTION test (src/emit.ts's UNSTRUCTURED_WORDLIKE_FRACTION,
// 0.4), not all-or-nothing — real repro, baseline doc p4: "205 57 tes 36 343 53 60 52 464 58"
// rendered as an ordinary paragraph until one stray word-like OCR-noise token stopped flipping the whole block to "structured".
describe('review marker fraction rule (regression: single stray word-like token)', () => {
  it('marks a numeral block with exactly one garbage word-like token (fraction 0.1, the real p4 repro)', () => {
    // 1 word-like token ("tes") / 10 total = 0.1, well below 0.4 — same
    // shape as the real unmarked line this bug produced.
    const page: DumpWord[] = dumpLine(1, 0.5, 0.1, '205 57 tes 36 343 53 60 52 464 58');
    const result = runWordsJson(page);
    const report = expectReport(result);
    const { md } = result;
    assert.match(md, /^> \[review: unstructured labels\] 205 57 tes 36 343 53 60 52 464 58$/m);
    assert.doesNotMatch(md, /^205 57 tes 36 343 53 60 52 464 58$/m, 'must not appear as a bare, unmarked paragraph');
    assert.ok(report.reviewBlocks >= 1);
  });

  it('leaves a prose block carrying inline numerals unmarked (fraction well above 0.4)', () => {
    // Realistic worst case for a prose false-positive: prose with inline numerals scattered
    // through it. Measured fraction 11 word-like / 16 total = 0.6875, comfortably above 0.4.
    const page: DumpWord[] = dumpLine(1, 0.5, 0.1, 'Because you learn through the 1 and have the life experience 3 to back it up');
    const result = runWordsJson(page);
    const report = expectReport(result);
    const { md } = result;
    assert.match(md, /^Because you learn through the 1 and have the life experience 3 to back it up\.?$/m);
    assert.doesNotMatch(md, />\s*\[review:[^\]]*\][^\n]*Because you learn/i);
    assert.equal(report.reviewBlocks, 0);
  });

  // Threshold-boundary coverage via the exported constant, same "at threshold excluded / just
  // below included" pattern as sparse-retry.test.ts's shouldRetrySparse boundary case.
  it(`is NOT unstructured at exactly the threshold (${UNSTRUCTURED_WORDLIKE_FRACTION}), the boundary is strict-less-than`, () => {
    // "one 1 two 2 three 3 four 4 5 6" -> 4 word-like ("one","two","three","four") / 10 = 0.4 exactly.
    assert.equal(UNSTRUCTURED_WORDLIKE_FRACTION, 0.4);
    const page: DumpWord[] = dumpLine(1, 0.5, 0.1, 'one 1 two 2 three 3 four 4 5 6');
    const result = runWordsJson(page);
    const report = expectReport(result);
    const { md } = result;
    assert.match(md, /^one 1 two 2 three 3 four 4 5 6\.?$/m);
    assert.equal(report.reviewBlocks, 0);
  });

  it('IS unstructured just below the threshold (fraction 0.3 < 0.4)', () => {
    // "one 1 two 2 three 3 4 5 6 7" -> 3 word-like ("one","two","three") / 10 = 0.3.
    const page: DumpWord[] = dumpLine(1, 0.5, 0.1, 'one 1 two 2 three 3 4 5 6 7');
    const result = runWordsJson(page);
    const report = expectReport(result);
    const { md } = result;
    assert.match(md, /^> \[review: unstructured labels\] one 1 two 2 three 3 4 5 6 7$/m);
    assert.ok(report.reviewBlocks >= 1);
  });
});

// --- measured-bounds derivation (real baseline doc pages 4 and 27) --------

// Word-like fraction per emitted block, live CLI output, real baseline doc.
const JUNK_BLOCK_FRACTIONS = [0.0, 0.0, 0.0, 0.1, 0.042]; // last: float aside
const PROSE_BLOCK_FRACTIONS = [0.743, 0.778, 0.819, 0.85, 0.857];

describe('UNSTRUCTURED_WORDLIKE_FRACTION: measured bounds around the cut', () => {
  it('0.4 sits strictly between the worst measured junk block and the lowest measured prose block', () => {
    assert.ok(Math.max(...JUNK_BLOCK_FRACTIONS) < UNSTRUCTURED_WORDLIKE_FRACTION);
    assert.ok(UNSTRUCTURED_WORDLIKE_FRACTION < Math.min(...PROSE_BLOCK_FRACTIONS));
  });
});

// Per-word confidence (0-100), real baseline doc, 2026-08-17: correct label
// words vs corrupted/junk values vs sub-60-confidence tokens on prose pages.
const JUNK_TOKEN_CONFIDENCES = [17, 0, 23, 1, 32, 43]; // "1543","P)","15332","2363","tes","XK" — worst: 43
const PROSE_LOW_TOKEN_CONFIDENCES = [0, 11, 13, 0, 20]; // sub-60 tokens on prose pages, every one itself junk
const PROSE_WORD_MIN_CONFIDENCE = 76; // lowest genuine prose word measured
const P4_CORRECT_LABEL_CONFIDENCE = { min: 91, median: 96 }; // p4 correct label words, same document/date

describe('LOW_CONFIDENCE_THRESHOLD: measured bounds around the cut', () => {
  it('60 sits strictly between the worst measured junk/corrupted token and the lowest measured genuine prose word', () => {
    assert.equal(LOW_CONFIDENCE_THRESHOLD, 60);
    assert.ok(Math.max(...JUNK_TOKEN_CONFIDENCES, ...PROSE_LOW_TOKEN_CONFIDENCES) < LOW_CONFIDENCE_THRESHOLD);
    assert.ok(LOW_CONFIDENCE_THRESHOLD < PROSE_WORD_MIN_CONFIDENCE);
  });

  it('60 also sits below the correct label words on p4 (min 91, median 96)', () => {
    assert.ok(LOW_CONFIDENCE_THRESHOLD < P4_CORRECT_LABEL_CONFIDENCE.min);
    assert.ok(P4_CORRECT_LABEL_CONFIDENCE.min < P4_CORRECT_LABEL_CONFIDENCE.median);
  });
});
