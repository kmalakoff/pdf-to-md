// public-corpus.test.ts — automated regression coverage (text + OCR paths) against real,
// checksum-pinned public documents (test/lib/corpus.ts), independent of any private/local file.

// Fetched once and cached under the package's .tmp/ (test/lib/corpus.ts); a test skips cleanly
// via `this.skip()` when the upstream URL is unreachable, rather than failing the suite for a flaky/gone mirror.

import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { auditWords } from '../../src/audit.ts';
import { CACHE_DIR, CORPUS, corpusPath } from '../lib/corpus.ts';
import { debugWordsPath, readDebugWords } from '../lib/debug-words.ts';
import { expectReport, run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

// Same normalization as no-silent-loss.test.ts's severity-1 check — see there for the rule.
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

describe('public corpus (Phase T): real documents, fetched + checksum-verified on demand', () => {
  it('layoutparser.pdf: born-digital text-layer PDF parses with plausible structure', async function () {
    const file = await corpusPath('layoutparser.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): layoutparser.pdf');
      this.skip();
      return;
    }

    const report = expectReport(run([file, '--stdout', '--json']));
    // Floors sit well below the measured run (16 pages, 42,702 chars, 2,669 chars/page,
    // 125 paragraphs, 0 junk headings — see test/lib/corpus.ts's CORPUS entry) so they only trip on a real regression.
    assert.equal(report.pages, 16, `expected 16 pages, got ${report.pages}`);
    assert.equal(report.sparse, false);
    assert.ok(report.charsPerPage > 1000, `expected > 1000 chars/page (measured 2669), got ${report.charsPerPage}`);
    assert.equal(report.junkHeadings, 0, `expected 0 junk headings, got ${report.junkHeadings}`);
    assert.ok(report.paragraphs > 50, `expected > 50 paragraphs (measured 125), got ${report.paragraphs}`);
  });

  it('c02-22.pdf: scanned page recognizes real content and loses no engine-recognized word', async function () {
    const file = await corpusPath('c02-22.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): c02-22.pdf');
      this.skip();
      return;
    }

    // Single page, forced OCR (~6s measured) — one CLI run yields both the QA report and
    // (via --debug-words=FILE) the word dump, so the severity-1 check below reuses it.
    const dump = debugWordsPath();
    const result = run([file, '--stdout', '--ocr', `--debug-words=${dump}`, '--json']);
    const report = expectReport(result);
    const { md } = result;
    assert.equal(report.path, 'ocr');
    // Floors sit well under the measured, repeat-verified values (304 recognized words, 1,504 chars).
    assert.ok(report.chars > 800, `expected > 800 recognized chars (measured 1504), got ${report.chars}`);
    assert.equal(report.junkHeadings, 0, `expected 0 junk headings, got ${report.junkHeadings}`);

    const words = readDebugWords(dump).map((w) => w.text);
    assert.ok(words.length > 100, `expected > 100 recognized words (measured 304), got ${words.length} — engine or flag broken?`);

    // Severity-1 invariant — see no-silent-loss.test.ts's header comment.
    const haystack = normalize(md);
    const missing: string[] = [];
    for (const w of words) {
      const needle = normalize(w);
      if (!needle) continue; // pure punctuation token, nothing to check
      if (!haystack.includes(needle)) missing.push(w);
    }
    assert.deepEqual(missing, [], `words recognized by the engine but missing from c02-22.pdf's markdown output: ${JSON.stringify(missing)}`);
  });

  it('usgs-fs20183035.pdf: chart/infographic page reproduces the review-marker + low-confidence defect class', async function () {
    const file = await corpusPath('usgs-fs20183035.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): usgs-fs20183035.pdf');
      this.skip();
      return;
    }

    // Forced OCR despite a good text layer — this fixture exists for the OCR path's chart
    // handling (test/lib/corpus.ts). One run (~8.4s measured) yields both the QA report and the word dump.
    const dump = debugWordsPath();
    const result = run([file, '--stdout', '--ocr', `--debug-words=${dump}`, '--json']);
    const report = expectReport(result);
    const { md } = result;
    assert.equal(report.path, 'ocr');
    assert.equal(report.pages, 2, `expected 2 pages, got ${report.pages}`);
    assert.equal(report.sparse, false);
    assert.equal(report.junkHeadings, 0, `expected 0 junk headings, got ${report.junkHeadings}`);

    // Floors sit well below the measured, repeat-verified values (reviewBlocks 1, lowConfidenceWords 62);
    // page 2's west-to-east state-name scatter produces both signals (see test/lib/corpus.ts).
    assert.ok(report.reviewBlocks >= 1, `expected reviewBlocks >= 1 (measured 1), got ${report.reviewBlocks}`);
    assert.ok(report.lowConfidenceWords >= 20, `expected lowConfidenceWords >= 20 (measured 62), got ${report.lowConfidenceWords}`);
    const page2 = report.pageStats.find((p) => p.page === 2);
    assert.ok(page2, 'expected a page 2 row in pageStats');
    assert.ok((page2?.reviewBlocks ?? 0) >= 1, `expected page 2's reviewBlocks >= 1, got ${page2?.reviewBlocks}`);

    // Severity-1 invariant, same as c02-22.pdf's check above, via the SHIPPED auditor
    // (src/audit.ts) rather than a hand-rolled scan — the review marker flags garbage, never loses it.
    const mdPath = path.join(scratchDir('usgs-corpus-'), 'usgs-fs20183035.md');
    writeFileSync(mdPath, md);
    const audit = auditWords(dump, mdPath);
    assert.equal(audit.missing, 0, `words recognized by the engine but missing from usgs-fs20183035.pdf's markdown output: ${audit.summaryLine}`);
  });

  it('ccitt.pdf: CCITTFax bitonal scan recognizes real text (regression fixture for pdf-open.ts wasmUrl)', async function () {
    const file = await corpusPath('ccitt.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): ccitt.pdf');
      this.skip();
      return;
    }

    // Forced OCR, one run yields both the QA report and (via --debug-words=FILE) the word
    // dump, reused for the severity-1 check below — same shape as c02-22.pdf's test above.
    //
    // This is THE regression test for the wasmUrl fix (src/pdf-open.ts): without wasmUrl wired
    // into pdfjs 6.x's getDocument(), this CCITTFax page decodes BLANK and every assertion below fails.
    const dump = debugWordsPath();
    const result = run([file, '--stdout', '--ocr', `--debug-words=${dump}`, '--json']);
    const report = expectReport(result);
    const { md } = result;
    assert.equal(report.path, 'ocr');
    assert.equal(report.pages, 1, `expected 1 page, got ${report.pages}`);
    // Floor sits well under the measured value (~4,519 chars) — trips hard if the page decoded blank.
    assert.ok(report.chars > 1000, `expected > 1000 recognized chars (measured ~4519), got ${report.chars}`);

    const words = readDebugWords(dump).map((w) => w.text);
    assert.ok(words.length > 100, `expected > 100 recognized words (measured ~728), got ${words.length} — engine or flag broken?`);

    const haystack = normalize(md);
    assert.ok(haystack.includes(normalize('LinnSequencer')) || haystack.includes(normalize('Sequencer')), 'expected "LinnSequencer" or "Sequencer" to appear in the recognized markdown');

    // Severity-1 invariant, same as c02-22.pdf's check above.
    const missing: string[] = [];
    for (const w of words) {
      const needle = normalize(w);
      if (!needle) continue;
      if (!haystack.includes(needle)) missing.push(w);
    }
    assert.deepEqual(missing, [], `words recognized by the engine but missing from ccitt.pdf's markdown output: ${JSON.stringify(missing)}`);
  });

  it('self-instruct.pdf: genuine two-column ACL layout de-braids into contiguous reading order', async function () {
    const file = await corpusPath('self-instruct.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): self-instruct.pdf');
      this.skip();
      return;
    }

    const result = run([file, '--stdout', '--json']);
    const report = expectReport(result);
    const { md } = result;
    assert.equal(report.path, 'text');
    assert.equal(report.pages, 23, `expected 23 pages, got ${report.pages}`);
    assert.ok(report.paragraphs > 200, `expected > 200 paragraphs (measured 434), got ${report.paragraphs}`);

    // A verified-present abstract sentence spanning the column break: if de-braiding
    // interleaves the two columns instead of reading each column top-to-bottom, this
    // sentence comes out chopped or reordered rather than as one contiguous run.
    const sentence = 'We introduce SELF-INSTRUCT, a framework for improving the instruction-following capabilities of pretrained language models by bootstrapping off their own generations.';
    assert.ok(md.includes(sentence), `expected the abstract's SELF-INSTRUCT sentence to appear contiguous and unbroken in the markdown`);
  });

  it('cjk-survey.pdf: CJK text decodes to real codepoints with no pdfjs cMaps wired in', async function () {
    const file = await corpusPath('cjk-survey.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): cjk-survey.pdf');
      this.skip();
      return;
    }

    // Text path only (openDocument() carries no cMapUrl) — deliberately not OCR'd, the engine is English-only.
    const result = run([file, '--stdout', '--json']);
    const report = expectReport(result);
    const { md } = result;
    assert.equal(report.path, 'text');
    assert.equal(report.pages, 110, `expected 110 pages, got ${report.pages}`);

    const cjkCount = (md.match(/[一-鿿]/g) ?? []).length;
    assert.ok(cjkCount > 500, `expected > 500 CJK codepoints (measured ~2427), got ${cjkCount}`);
    assert.ok(!md.includes('�'), 'expected no U+FFFD replacement chars in the markdown — a real cMap-less decode failure would introduce them');
  });

  it('gao-24-107307.pdf: multi-line bulleted findings reconstruct as list items', async function () {
    const file = await corpusPath('gao-24-107307.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): gao-24-107307.pdf');
      this.skip();
      return;
    }

    const report = expectReport(run([file, '--stdout', '--json']));
    assert.equal(report.path, 'text');
    assert.equal(report.pages, 13, `expected 13 pages, got ${report.pages}`);
    assert.ok((report.listItems ?? 0) > 0, `expected listItems > 0 (measured 12), got ${report.listItems}`);
  });

  it('usgs-tm9a0.pdf: title/subtitle/chapter/section stack exercises 5 distinct heading sizes', async function () {
    const file = await corpusPath('usgs-tm9a0.pdf');
    if (!file) {
      console.log('corpus file unavailable (offline?): usgs-tm9a0.pdf');
      this.skip();
      return;
    }

    const report = expectReport(run([file, '--stdout', '--json']));
    assert.equal(report.path, 'text');
    assert.equal(report.pages, 11, `expected 11 pages, got ${report.pages}`);
    assert.ok((report.headingSizes?.length ?? 0) >= 4, `expected >= 4 distinct heading sizes (measured 5: 22/20/18/16/14pt), got ${report.headingSizes?.length}`);
  });

  it('corpusPath() resolves to null (never throws) when the network is unreachable', async () => {
    // Proves the offline-skip branch actually executes: deletes the cached file (else a cache
    // hit would short-circuit first) then forces the download to fail via corpus.ts's NO_NETWORK_ENV escape hatch.
    const entry = CORPUS.find((e) => e.name === 'c02-22.pdf');
    assert.ok(entry, 'c02-22.pdf missing from the CORPUS table');
    const dest = path.join(CACHE_DIR, entry.name);
    rmSync(dest, { force: true });

    process.env.PDF_TO_MD_CORPUS_NO_NETWORK = '1';
    let result: string | null;
    try {
      result = await corpusPath(entry.name);
    } finally {
      delete process.env.PDF_TO_MD_CORPUS_NO_NETWORK;
    }

    assert.equal(result, null, 'expected corpusPath() to resolve to null under simulated network failure');
    assert.equal(existsSync(`${dest}.building`), false, 'a failed build must not leave a .building staging file behind');

    // Restore the cache (best-effort) so a later test run / CI cache warm
    // isn't left cold by this test having deleted it.
    await corpusPath(entry.name);
  });
});
