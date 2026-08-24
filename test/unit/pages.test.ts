// pages.test.ts — page-targeted re-extraction: the CLI --pages N[-M] flag, and
// buildReport/buildOcrReport's per-page pageStats array (src/report.ts). See README's "Per-page workflow".

import assert from 'node:assert/strict';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

describe('--pages: selects a source page subset (fixture 8, text-twopage.pdf)', () => {
  const fixture = fixturePath('text-twopage.pdf');

  it('--pages 2 emits only page 2\'s content, marked "### p2" (not renumbered to p1)', () => {
    const { md, status } = run([fixture, '--stdout', '--page-markers', '--pages', '2']);
    assert.equal(status, 0);
    assert.match(md, /^### p2\s*$/m);
    assert.doesNotMatch(md, /^### p1\s*$/m);
    assert.match(md, /windmill turning above golden summer fields/i);
    assert.doesNotMatch(md, /lighthouse standing over a cold northern sea/i);
  });

  it('--pages 1 emits only page 1\'s content, marked "### p1"', () => {
    const { md, status } = run([fixture, '--stdout', '--page-markers', '--pages', '1']);
    assert.equal(status, 0);
    assert.match(md, /^### p1\s*$/m);
    assert.doesNotMatch(md, /^### p2\s*$/m);
    assert.match(md, /lighthouse standing over a cold northern sea/i);
    assert.doesNotMatch(md, /windmill turning above golden summer fields/i);
  });

  it('--pages 1-2 (a range) emits both pages, each under its own source number', () => {
    const { md, status } = run([fixture, '--stdout', '--page-markers', '--pages', '1-2']);
    assert.equal(status, 0);
    assert.match(md, /^### p1\s*$/m);
    assert.match(md, /^### p2\s*$/m);
  });

  it("an out-of-range --pages clamps to the document's last page instead of erroring", () => {
    const { md, status } = run([fixture, '--stdout', '--page-markers', '--pages', '5-9']);
    assert.equal(status, 0);
    assert.match(md, /^### p2\s*$/m);
    assert.match(md, /windmill turning above golden summer fields/i);
  });

  it("report.pages (and so the chars/page math) reflects the SELECTED page count, not the document's", () => {
    // If `numPages` were wrongly the document's total (2) instead of the selected count (1),
    // report.pages would read 2 and charsPerPage would be roughly half the selected page's own content length.
    const report = expectReport(run([fixture, '--stdout', '--page-markers', '--pages', '2', '--json']));
    assert.equal(report.pages, 1);
    assert.equal(report.charsPerPage, Math.round(report.chars / 1));
  });
});

describe('--pages: invalid specs are a usage error, not silently ignored', () => {
  const fixture = fixturePath('text-twopage.pdf');

  for (const bad of ['0', 'abc', '9-3', '-1']) {
    it(`--pages ${bad} exits nonzero with a usage message on stderr`, () => {
      // '-1' in particular: node:util's parseArgs refuses to consume a value starting with `-`
      // as an option argument (throws "argument is ambiguous") rather than silently treating it as a new flag.
      const { status, stderr } = run([fixture, '--stdout', '--pages', bad]);
      assert.notEqual(status, 0);
      assert.match(stderr, /usage:/i);
      assert.match(stderr, /--pages/);
    });
  }
});

describe('pageStats: per-page QA rows in the --json report', () => {
  it('ocr-badge.pdf (--ocr): one row, with the badge float counted', () => {
    const report = expectReport(run([fixturePath('ocr-badge.pdf'), '--stdout', '--ocr', '--json']));
    assert.equal(report.pageStats.length, 1);
    assert.equal(report.pageStats[0].page, 1);
    assert.ok(report.pageStats[0].floats >= 1, 'expected the badge fragment counted as a float');
  });

  it('text-twopage.pdf (--page-markers): two rows with the right source page numbers', () => {
    const report = expectReport(run([fixturePath('text-twopage.pdf'), '--stdout', '--page-markers', '--json']));
    assert.equal(report.pageStats.length, 2);
    assert.deepEqual(
      report.pageStats.map((r) => r.page),
      [1, 2]
    );
  });

  // Control case: both pages end in ordinary terminal punctuation, so if the terminal-punctuation
  // character class were too narrow, this prose would false-positive as dangling.
  it('text-twopage.pdf: ordinary sentence-ending prose reports danglingLong/danglingShort 0 on both pages and at the document level', () => {
    const report = expectReport(run([fixturePath('text-twopage.pdf'), '--stdout', '--page-markers', '--json']));
    assert.deepEqual(
      report.pageStats.map((r) => r.danglingLong),
      [0, 0]
    );
    assert.deepEqual(
      report.pageStats.map((r) => r.danglingShort),
      [0, 0]
    );
    assert.equal(report.danglingLong, 0);
    assert.equal(report.danglingShort, 0);
  });

  // Negative control for column-break.test.ts's positive case: no column break, no gutter
  // fragment, every paragraph ends in a period.
  it('ocr-single.pdf (--ocr, clean fixture): danglingLong and danglingShort are both 0', () => {
    const report = expectReport(run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--json']));
    assert.equal(report.pageStats[0].danglingLong, 0);
    assert.equal(report.pageStats[0].danglingShort, 0);
    assert.equal(report.danglingLong, 0);
    assert.equal(report.danglingShort, 0);
  });

  // pageStats is measured independently of output formatting, so it's always populated and its
  // numbers agree exactly with a --page-markers run — markers change what output looks like, not what gets measured.
  it('text-twopage.pdf WITHOUT --page-markers: pageStats is still populated, with numbers identical to a --page-markers run', () => {
    const unmarked = run([fixturePath('text-twopage.pdf'), '--stdout', '--json']);
    const marked = run([fixturePath('text-twopage.pdf'), '--stdout', '--page-markers', '--json']);
    const unmarkedReport = expectReport(unmarked);
    const markedReport = expectReport(marked);
    assert.equal(unmarkedReport.pageStats.length, 2, 'pageStats must be populated without --page-markers');
    assert.deepEqual(unmarkedReport.pageStats, markedReport.pageStats);
    assert.equal(unmarkedReport.danglingLong, markedReport.danglingLong);
    assert.equal(unmarkedReport.danglingShort, markedReport.danglingShort);
    assert.equal(unmarkedReport.reviewBlocks, markedReport.reviewBlocks);
    // pageStatsNote is gone entirely — no such field, on either run.
    assert.equal((unmarkedReport as unknown as { pageStatsNote?: string }).pageStatsNote, undefined);
  });
});
