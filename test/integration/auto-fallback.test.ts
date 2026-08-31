// auto-fallback.test.ts — the default (no --ocr) path's own image-page detection: fixture 3
// (ocr-single.pdf) has no real text layer, so the CLI should measure ~0 chars/page and fall back to OCR (tesseract.js) on its own; --no-ocr suppresses that and just warns.

import assert from 'node:assert/strict';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

const fixture = fixturePath('ocr-single.pdf');

describe('auto OCR fallback', () => {
  it('without --ocr: prints a fallback notice on stderr and marks ocrFallback in the JSON report', () => {
    const result = run([fixture, '--stdout', '--json']);
    const report = expectReport(result);
    assert.match(result.stderr, /falling back to OCR/i);
    assert.equal(report.ocrFallback, true);
    assert.equal(report.path, 'ocr');
    // and the fallback actually recovered real content, not an empty page
    assert.ok(report.chars > 100, `expected recovered OCR content, got ${report.chars} chars`);
  });

  // Pins the fallback notice string under --format=raw|txt too (shared
  // needsOcrFallback/ocrFallbackNotice helpers, src/extract.ts) so a reword on either side can't go uncaught.
  it('--format=raw: prints the identical fallback notice and the raw Analysis lands on the OCR path', () => {
    const { stdout, stderr, status } = run([fixture, '--stdout', '--format=raw']);
    assert.equal(status, 0, stderr);
    assert.match(stderr, /chars\/page .* pages are images of text; falling back to OCR \(suppress with --no-ocr\)/);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.report.path, 'ocr');
    assert.equal(parsed.report.ocrFallback, true);
  });

  it('with --no-ocr: never falls back, and reports sparse near-empty output', () => {
    const result = run([fixture, '--stdout', '--no-ocr', '--json']);
    const report = expectReport(result);
    assert.doesNotMatch(result.stderr, /falling back to OCR/i);
    assert.equal(report.sparse, true);
    assert.ok(report.chars < 20, `expected near-empty text-layer output, got ${report.chars} chars`);
  });
});
