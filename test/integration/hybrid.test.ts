// hybrid.test.ts — hybrid-page detection on the DEFAULT (text) path, fixture 9 (text-hybrid.pdf).
// See src/collect.ts's `hasLargeImage` and README's "Design contract" hybrid-page section.

// text-hybrid.pdf has a real text layer PLUS a large embedded bitmap with its own baked-in
// words (STRATEGY / SIGNATURE / PROFILE) — the text path can never see the image's words; --ocr can.

import assert from 'node:assert/strict';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

const fixture = fixturePath('text-hybrid.pdf');

describe('hybrid-page detection: text-hybrid.pdf', () => {
  it('text path: warns on stderr and flags the page in the JSON report', () => {
    const result = run([fixture, '--stdout', '--page-markers', '--json']);
    const report = expectReport(result);
    const { md, stderr } = result;
    // The warning is advisory, not prescriptive — a prescriptive rerun instruction would actively
    // degrade correct text-layer output on a page with a large image but NO baked-in text ("I" -> "|", stray em-dashes). It tells the caller to COMPARE, not replace.
    assert.match(stderr, /p1: text layer used but page carries large image\(s\); if it has baked-in text this output won't have it — compare \(don't blindly replace\) against --pages 1 --ocr, which can itself introduce errors/);
    assert.deepEqual(report.hybridPages, [1]);
    assert.equal(report.pageStats[0].largeImages, true);

    // the real text layer is extracted intact...
    assert.match(md, /survey team documented soil samples across the northern ridge/i);
    // ...but the image's baked-in words are never seen on this path — the
    // gap the warning above exists to surface.
    assert.doesNotMatch(md, /STRATEGY/);
    assert.doesNotMatch(md, /SIGNATURE/);
    assert.doesNotMatch(md, /PROFILE/);
  });

  it('--ocr on the flagged page: recovers the baked-in words the text path missed', () => {
    const { md } = run([fixture, '--stdout', '--ocr']);
    for (const w of ['STRATEGY', 'SIGNATURE', 'PROFILE']) {
      assert.match(md, new RegExp(`\\b${w}\\b`), `expected baked-in word "${w}" recovered via --ocr`);
    }
    // and the real prose is still there too (forced OCR re-reads everything,
    // not just the image)
    assert.match(md, /survey team documented soil samples across the northern ridge/i);
  });
});
