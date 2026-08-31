// real-replay.test.ts — diff-bound companion to synthetic-replay.test.ts: replays 100 pages of
// real (scrambled, see test/fixtures/real-replay/README.md) OCR data and checks a diff-line BOUND, not byte equality.

// If the diff-vs-frozen line count grows past DIFF_BOUND, review it: raise the bound with a reason,
// or bump src/report.ts's OUTPUT_VERSION and refreeze the expectation.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditWords } from '@effortlessmotion/pdf-to-md';
import cr from 'cr';
import { run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'real-replay');
const WORDS_GEO = path.join(FIXTURES, 'vision-words-geo.jsonl');
const WORDS = path.join(FIXTURES, 'vision-words.jsonl');
const FROZEN_MD = path.join(FIXTURES, 'vision-full.md');
const DIFF_BOUND = 400;

describe('real replay gate: 100-page real-OCR word dump -> markdown within diff bound', () => {
  const { status, stderr, md } = run([`--words-json=${WORDS_GEO}`, '--stdout', '--ocr']);

  it('runs cleanly over the full 100-page dump', () => {
    assert.equal(status, 0, stderr);
    assert.ok(md.length > 150_000, `expected > 150,000 chars, got ${md.length}`);
  });

  it('severity-1: MISSING=0 via the shipped auditor', () => {
    const tmp = path.join(scratchDir('real-replay-'), 'replayed.md');
    writeFileSync(tmp, md);
    const result = auditWords(WORDS, tmp);
    assert.equal(result.missing, 0, `expected MISSING=0, got: ${result.summaryLine}`);
  });

  it('stays within the diff-line bound against the frozen replay', () => {
    // cr(): git autocrlf checks the frozen file out with CRLF on Windows; the CLI always emits LF.
    const frozen = cr(readFileSync(FROZEN_MD, 'utf8')).split('\n');
    const replayed = md.split('\n');
    const frozenSet = new Set(frozen);
    const replaySet = new Set(replayed);
    const diffLines = replayed.filter((l) => !frozenSet.has(l)).length + frozen.filter((l) => !replaySet.has(l)).length;
    assert.ok(diffLines < DIFF_BOUND, `${diffLines} diff lines >= bound ${DIFF_BOUND} — see this file's header`);
  });
});
