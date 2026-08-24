// text-path.test.ts — default (pdf.js text-layer) path, fixtures 1-2. Ground truth by
// construction: test/lib/make-fixtures.ts draws these with a real embedded text layer and known sentences, so assertions are against exact expected content.

import assert from 'node:assert/strict';
import { HAS_DICT } from '../lib/dict.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

// Hyphen-rejoin (src/markdown.ts, same DICT_PATH as src/emit.ts) only closes a line-final
// hyphen when the joined form is a real dictionary word — no dictionary means every hyphen stays unresolved (a visible '-' beats a silent join).

describe('text path: text-single.pdf', () => {
  const result = run([fixturePath('text-single.pdf'), '--stdout', '--json']);
  const report = expectReport(result);
  const { md } = result;

  it('emits the heading as a real #-heading', () => {
    assert.match(md, /^# Garden Notes$/m);
  });

  it('contains every expected sentence intact', () => {
    assert.match(md, /The morning sun crossed the quiet garden slowly while silver dew still rested on the grass\./);
    assert.match(md, /Visitors often stopped to admire the roses before wandering further into the orchard\./);
  });

  it('closes the line-final hyphen into a dictionary word', function (this: Mocha.Context) {
    if (!HAS_DICT) this.skip(); // dead unless PDF_TO_MD_DICT_PATH overrides — the bundled dictionary is always present
    assert.match(md, /Every gardener needs a spark of creative energy to keep the borders alive\./);
    assert.doesNotMatch(md, /creat-\s*ive/);
  });

  it('emits the short list as real list items', () => {
    assert.match(md, /^- Water the roses every morning$/m);
    assert.match(md, /^- Trim the hedges before summer$/m);
    assert.match(md, /^- Rake fallen leaves in autumn$/m);
  });

  it('produces a sane --json report', () => {
    assert.equal(report.junkHeadings, 0);
    assert.equal(report.headings, 1);
    assert.equal(report.listItems, 3);
    // Dictionary-dependent (see HAS_DICT above) — strictly asserted, not skipped, either way.
    assert.equal(report.closedHyphens, HAS_DICT ? 1 : 0);
    assert.equal(report.sparse, false);
  });
});

describe('text path: text-twocol.pdf', () => {
  const result = run([fixturePath('text-twocol.pdf'), '--stdout', '--json']);
  const report = expectReport(result);
  const { md } = result;

  it('contains every expected sentence from both columns', () => {
    assert.match(md, /The old library sat quiet beside the tall oak trees\./);
    assert.match(md, /Readers came in from the rain\./);
    assert.match(md, /Volunteers held a weekend book sale\./);
    assert.match(md, /The harbor market opened early beneath a pale morning sky\./);
    assert.match(md, /Sailors unloaded crates of fish\./);
    assert.match(md, /Fishermen mended their tattered nets\./);
  });

  it('de-braids the two columns in the correct order (left column, then right)', () => {
    const leftLast = md.indexOf('Volunteers held a weekend book sale.');
    const rightFirst = md.indexOf('The harbor market opened early beneath a pale morning sky.');
    assert.ok(leftLast >= 0, 'left column content missing');
    assert.ok(rightFirst >= 0, 'right column content missing');
    assert.ok(leftLast < rightFirst, 'left column should appear before right column');
  });

  it('produces a sane --json report (no junk headings, no sparse warning)', () => {
    assert.equal(report.junkHeadings, 0);
    assert.equal(report.headings, 0);
    assert.equal(report.sparse, false);
  });
});
