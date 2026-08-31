// synthetic-replay.test.ts — THE geometry-drift + OUTPUT_VERSION enforcement gate: a hand-built,
// deterministic 4-page word dump must replay through the shipped pipeline to the frozen markdown EXACTLY, byte for byte.

// No line-final hyphens by construction, so output doesn't depend on dictionary availability —
// deterministic on Linux CI too. Page-by-page behavior coverage is readable directly from the fixture files.

// If a deliberate change breaks the exact-equality assertion, bump src/report.ts's OUTPUT_VERSION and
// refreeze by rerunning the replay into the expectation file (real-replay.test.ts is the same gate, diff-bound rather than exact).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cr from 'cr';
import { auditWords, OUTPUT_VERSION } from '@effortlessmotion/pdf-to-md';
import { expectReport, run } from '../lib/run.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORDS = path.join(here, '..', 'fixtures', 'synthetic-replay.words.jsonl');
const EXPECTED_MD = path.join(here, '..', 'fixtures', 'synthetic-replay.expected.md');

describe('synthetic replay gate: frozen word dump -> exact frozen markdown', () => {
  const runResult = run([`--words-json=${WORDS}`, '--stdout', '--ocr', '--json']);
  const { status, stderr, md } = runResult;

  it('reproduces the frozen expected markdown EXACTLY (geometry/emission drift gate)', () => {
    assert.equal(status, 0, stderr);
    // cr(): git autocrlf checks the frozen file out with CRLF on Windows; the CLI always emits LF.
    assert.equal(md, cr(readFileSync(EXPECTED_MD, 'utf8')), "replayed markdown differs from test/fixtures/synthetic-replay.expected.md — if this change is deliberate, refreeze the expectation AND bump OUTPUT_VERSION (see this file's header)");
  });

  it('severity-1: MISSING=0 via the shipped auditor against the frozen pair', () => {
    const result = auditWords(WORDS, EXPECTED_MD);
    assert.equal(result.missing, 0, `expected MISSING=0, got: ${result.summaryLine}`);
    assert.equal(result.words, 150, 'the frozen dump should parse to exactly 150 words');
  });

  it('the report reflects every covered behavior (floats, review, low-confidence, headings)', () => {
    const report = expectReport(runResult);
    assert.equal(report.outputVersion, OUTPUT_VERSION);
    assert.equal(report.path, 'ocr');
    assert.equal(report.pages, 4);
    assert.equal(report.headings, 4);
    assert.equal(report.junkHeadings, 0);
    assert.equal(report.floats, 3);
    assert.equal(report.reviewBlocks, 1);
    assert.equal(report.lowConfidenceWords, 1);
    assert.deepEqual(report.pageStats[1].lowConfidenceSample, ['m00rings']);
  });
});
