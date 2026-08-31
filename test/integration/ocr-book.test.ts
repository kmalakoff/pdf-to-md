// ocr-book.test.ts — fixture 10 (ocr-book.pdf), a synthetic "two-column scanned book" (ground
// truth by construction; see test/lib/make-fixtures.ts's "fixture 10" comment for layout rationale).

// Exercises the OCR path end-to-end: 3 pages, a cross-column sentence join on p1 (the same
// mechanism column-break.test.ts covers single-page), column read order, and a wide page 3 that must not misfire the two-column vote.

import assert from 'node:assert/strict';
import { debugWordsPath, readDebugWords } from '../lib/debug-words.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

describe('OCR path: ocr-book.pdf (synthetic two-column scanned book)', () => {
  const dump = debugWordsPath();
  const result = run([fixturePath('ocr-book.pdf'), '--stdout', '--ocr', '--json', `--debug-words=${dump}`]);
  const report = expectReport(result);
  const { md } = result;

  it('emits all three page markers', () => {
    for (const n of [1, 2, 3]) {
      assert.match(md, new RegExp(`^### p${n}\\s*$`, 'm'), `expected "### p${n}" marker`);
    }
  });

  describe('page 1: two-column read order and cross-column join', () => {
    it('recognizes the display heading', () => {
      assert.match(md, /^#+\s*Field Journal\s*$/im);
    });

    it('emits the left column before the right column', () => {
      const left = md.indexOf('The old baker sold warm bread at dawn');
      const right = md.indexOf('Sailors packed the boxes near the harbor at noon');
      assert.ok(left >= 0, 'expected the left-column sentence in the output');
      assert.ok(right >= 0, 'expected the right-column sentence in the output');
      assert.ok(left < right, 'left column should be fully emitted before the right column starts');
    });

    it('joins the sentence that runs from the bottom of the left column to the top of the right column', () => {
      assert.match(md, /Farmers met near the well to trade fresh eggs and milk while children ran and laughed at the geese that wandered near the old barn before the sun rose today\.?/i);
    });

    it('reports the join as whole, not dangling', () => {
      assert.equal(report.pageStats[0].danglingLong, 0);
    });
  });

  describe('page 3: wide single column does not misfire the two-column vote', () => {
    it('recognizes the display heading', () => {
      assert.match(md, /^#+\s*Open Road\s*$/im);
    });

    it('keeps the wide-page sentence contiguous, not split at mid-page', () => {
      assert.match(md, /The old wagon rolled across a wide stone bridge\.?/i);
    });

    it('keeps the other wide-page sentences contiguous too', () => {
      assert.match(md, /The travelers walked the winding road past quiet farms and golden wheat fields\.?/i);
      assert.match(md, /Merchants set out early for the coast while gulls circled the busy harbor\.?/i);
    });
  });

  it('no dumped word is missing from the markdown (severity-1)', () => {
    const words = readDebugWords(dump).map((w) => w.text);
    assert.ok(words.length > 0, '--debug-words produced no words — engine or flag broken');

    const haystack = normalize(md);
    const missing: string[] = [];
    for (const w of words) {
      const needle = normalize(w);
      if (!needle) continue; // pure punctuation token, nothing to check
      if (!haystack.includes(needle)) missing.push(w);
    }
    assert.deepEqual(missing, [], `words recognized by the engine but missing from ocr-book.pdf's markdown output: ${JSON.stringify(missing)}`);
  });

  it('reports a sane QA summary (no junk headings)', () => {
    assert.equal(report.junkHeadings, 0);
  });
});
