// column-break.test.ts — fixture 7 (cross-column layout) plus constructed-word geometry cases.
// Cross-column join rule lives in src/emit.ts; display-junk gutter-fragment routing in src/geometry.ts.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_GUTTER_INK_FRAC, MIN_COL_SHARE, MIN_COL_WORDS } from '../../src/geometry.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

describe('OCR path: ocr-colbreak.pdf', () => {
  const result = run([fixturePath('ocr-colbreak.pdf'), '--stdout', '--ocr', '--json']);
  const report = expectReport(result);
  const { md } = result;

  // --- passing: what the tool already gets right -------------------------

  it('recognizes words from both columns', () => {
    for (const w of ['Readers', 'library', 'shelves', 'closing', 'reading', 'evening', 'Lamps', 'desks']) {
      assert.ok(new RegExp(`\\b${w}\\b`, 'i').test(md), `expected word "${w}" not found in OCR output`);
    }
  });

  it('de-braids the columns without interleaving lines mid-line', () => {
    const left = md.indexOf('Readers filled the old');
    const right = md.indexOf('reading room stayed warm');
    assert.ok(left >= 0 && right >= 0, 'expected column content missing');
    assert.ok(left < right, 'left column should be emitted before the right column');
  });

  // Standing regression guard: the apostrophe in a display heading must survive tesseract.js
  // and src/lines.ts's typographic folding (curly quote -> ASCII), never dropped.
  it("preserves an apostrophe in a display heading (OWNER'S, not OWNERS)", () => {
    assert.match(md, /OWNER'S/i);
    assert.doesNotMatch(md, /\bOWNERS\b/i);
  });

  // The fragment may land in its own block; it must never be spliced onto a body line.
  // Same-line only — a blank-line-separated block is a separate paragraph, not a splice.
  it('never splices the gutter fragment inline into a body line', () => {
    assert.doesNotMatch(md, /the quiet[ \t]+1\/3/i);
    assert.doesNotMatch(md, /1\/3[ \t]+reading room/i);
  });

  // Cross-column join: src/emit.ts joins on column change + open paragraph without
  // terminal punctuation + lowercase continuation start.
  it('keeps a sentence that runs across the column break in one paragraph', () => {
    assert.match(md, /Readers filled the old library and read the shelves till closing time, and the quiet reading room stayed warm that evening\.?/i);
  });

  // With the sentence now joined, this page no longer dangles — the detector's positive
  // case is the conservative-miss test in the constructed-words suite below.
  it('reports danglingLong 0 now that the sentence is whole', () => {
    assert.equal(report.pageStats[0].danglingLong, 0);
  });
});

// Geometry-level cases via --words-json (constructed word dumps): image fixtures can't exercise
// these — tesseract.js never recognizes the display-size gutter fragment, and the conservative-miss case needs a page constructed to dangle.

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
  const dir = scratchDir('colbreak-words-');
  const file = path.join(dir, 'words.jsonl');
  writeFileSync(file, words.map((w) => JSON.stringify(w)).join('\n'));
  return run([`--words-json=${file}`, '--stdout', '--ocr', '--json']);
}

describe('column break via constructed word dumps (--words-json)', () => {
  // Two clean columns; the left column's paragraph runs out mid-sentence
  // and the right column continues in lowercase — the join case.
  const joinPage: DumpWord[] = [
    ...dumpLine(1, 0.8, 0.05, 'The lantern keeper crossed the wet'),
    ...dumpLine(1, 0.775, 0.05, 'stone bridge before dawn and the'),
    ...dumpLine(1, 0.75, 0.05, 'cold morning wind from the'),
    ...dumpLine(1, 0.8, 0.55, 'quiet harbor kept him awake until'),
    ...dumpLine(1, 0.775, 0.55, 'sunrise came over the eastern piers.'),
    ...dumpLine(1, 0.75, 0.55, 'Gulls gathered along the rail.'),
  ];

  it('joins a dangling left column onto a lowercase right-column start', () => {
    const { md } = runWordsJson(joinPage);
    assert.match(md, /cold morning wind from the quiet harbor kept him awake until sunrise/i);
  });

  // Same shape, but the right column opens with a capitalized proper noun — deliberately
  // NOT joined; the cost is what pageStats.danglingLong exists to flag.
  const capitalPage: DumpWord[] = [
    ...dumpLine(1, 0.8, 0.05, 'The lantern keeper crossed the wet'),
    ...dumpLine(1, 0.775, 0.05, 'stone bridge before dawn and then'),
    ...dumpLine(1, 0.75, 0.05, 'waited a long while for'),
    ...dumpLine(1, 0.8, 0.55, 'Sherlock to arrive with the tide.'),
    ...dumpLine(1, 0.775, 0.55, 'Nobody else came down that night.'),
    ...dumpLine(1, 0.75, 0.55, 'Lamps burned along the rail.'),
  ];

  it('declines to join a capitalized continuation and FLAGS it via danglingLong', () => {
    const capitalResult = runWordsJson(capitalPage);
    const report = expectReport(capitalResult);
    const { md } = capitalResult;
    assert.doesNotMatch(md, /waited a long while for Sherlock/i);
    assert.ok(report.pageStats[0].danglingLong >= 1, 'expected the dangling left column counted as danglingLong');
  });

  // A display-size junk fragment (no run of 3+ letters), too WIDE for the ordinary float net
  // (0.179 page width measured vs the 0.15 cap) — routed to floats, unblocking the join beneath it.
  const gutterFragmentPage: DumpWord[] = [...joinPage, { page: 1, text: '1/3', x: 0.72, y: 0.86, w: 0.18, h: 0.064 }];

  it('routes a display-size junk fragment to floats, not body flow', () => {
    const gutterResult = runWordsJson(gutterFragmentPage);
    const report = expectReport(gutterResult);
    const { md } = gutterResult;
    assert.equal(report.floats, 1, 'the display "1/3" should be recovered as a float');
    assert.match(md, /^>\s*\[floats\].*1\/3/im);
    const body = md
      .split('\n')
      .filter((l) => !l.trim().startsWith('>'))
      .join('\n');
    assert.doesNotMatch(body, /^\s*1\/3\s*$/m, '"1/3" should not stand as its own body block');
    // and the fragment no longer blocks the sentence join beneath it
    assert.match(md, /cold morning wind from the quiet harbor kept him awake until sunrise/i);
  });
});

// --- two-column decision: gutter-ink bimodal gap (100 baseline pages) -----

// Gutter ink = share of body-height words whose box straddles the column split. Measured
// over 100 baseline pages: 2-col pages <=0.017, single-col >=0.047; MAX_GUTTER_INK_FRAC sits in that gap with >=1.6x margin.
const TWO_COL_GUTTER_INK_MAX = 0.017;
const SINGLE_COL_GUTTER_INK_MIN = 0.047;

// Population floors, same 100-page measurement: data rail <=11% of body words vs the
// thinnest genuine column at 31% (MIN_COL_SHARE); genuine columns measure >=76 words (MIN_COL_WORDS).
const MIN_COL_SHARE_RAIL_MAX = 0.11;
const MIN_COL_SHARE_GENUINE_MIN = 0.31;
const MIN_COL_WORDS_GENUINE_MIN = 76;

describe('two-column decision: gutter-ink bimodal gap', () => {
  it('the real production constant sits strictly between the measured two-column max and single-column min', () => {
    assert.ok(TWO_COL_GUTTER_INK_MAX < MAX_GUTTER_INK_FRAC);
    assert.ok(MAX_GUTTER_INK_FRAC < SINGLE_COL_GUTTER_INK_MIN);
  });

  it('MIN_COL_SHARE sits strictly between the measured data-rail share and the thinnest genuine column', () => {
    assert.ok(MIN_COL_SHARE_RAIL_MAX < MIN_COL_SHARE);
    assert.ok(MIN_COL_SHARE < MIN_COL_SHARE_GENUINE_MIN);
  });

  it('MIN_COL_WORDS sits at or below every measured genuine column word count', () => {
    assert.ok(MIN_COL_WORDS <= MIN_COL_WORDS_GENUINE_MIN);
  });

  // Two words straddling x=0.5, added to the clean two-column joinPage
  // shape above, push gutter ink over the single-column floor.
  const straddlingPage: DumpWord[] = [
    ...[
      ...dumpLine(1, 0.8, 0.05, 'The lantern keeper crossed the wet'),
      ...dumpLine(1, 0.775, 0.05, 'stone bridge before dawn and the'),
      ...dumpLine(1, 0.75, 0.05, 'cold morning wind from the'),
      ...dumpLine(1, 0.8, 0.55, 'quiet harbor kept him awake until'),
      ...dumpLine(1, 0.775, 0.55, 'sunrise came over the eastern piers.'),
      ...dumpLine(1, 0.75, 0.55, 'Gulls gathered along the rail.'),
    ],
    { page: 1, text: 'straddleone', x: 0.48, y: 0.95, w: 0.06, h: 0.017 },
    { page: 1, text: 'straddletwo', x: 0.48, y: 0.6, w: 0.06, h: 0.017 },
  ];

  it('a page with gutter ink above the cut is NOT split into two columns (same-y left/right lines merge)', () => {
    const { md } = runWordsJson(straddlingPage);
    assert.match(md, /cold morning wind from the Gulls gathered along the rail/i);
  });
});
