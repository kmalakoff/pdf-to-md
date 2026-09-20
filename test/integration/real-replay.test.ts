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
import { safeRmSync } from 'fs-remove-compat';
import { run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, '..', 'fixtures', 'real-replay');
const WORDS_GEO = path.join(FIXTURES, 'vision-words-geo.jsonl');
const WORDS = path.join(FIXTURES, 'vision-words.jsonl');
const FROZEN_MD = path.join(FIXTURES, 'vision-full.md');
const DIFF_BOUND = 400;
const EMPTY_PAGE_STATUS = 'p3: Vision recognized no text, page emitted with no OCR text';

interface DerivedAuditWords {
  records: number;
  statusPages: number[];
}

function isReplayWord(value: unknown): value is { page: number; text: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as { page?: unknown; text?: unknown };
  return typeof record.page === 'number' && Number.isSafeInteger(record.page) && record.page > 0 && typeof record.text === 'string' && record.text.length > 0;
}

function deriveAuditWords(wordsPath: string, outputPath: string): DerivedAuditWords {
  const lines = readFileSync(wordsPath, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const records: string[] = [];
  const statusPages: number[] = [];

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === EMPTY_PAGE_STATUS) {
      statusPages.push(3);
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`unexpected non-JSON line ${index + 1} in real replay words: ${JSON.stringify(line)}`);
    }
    if (!isReplayWord(record)) throw new Error(`invalid word record at line ${index + 1} in real replay words`);
    records.push(rawLine);
  }

  writeFileSync(outputPath, `${records.join('\n')}\n`);
  return { records: records.length, statusPages };
}

describe('real replay gate: 100-page real-OCR word dump -> markdown within diff bound', () => {
  const dir = scratchDir('real-replay-');
  const auditWordsPath = path.join(dir, 'vision-words.clean.jsonl');
  deriveAuditWords(WORDS, auditWordsPath);
  const { status, stderr, md } = run([`--words-json=${WORDS_GEO}`, '--stdout', '--ocr']);

  after(() => safeRmSync(dir, { recursive: true, force: true }));

  for (const [name, eol] of [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ]) {
    it(`derives ${name} audit evidence by removing only the known empty-page notice`, () => {
      const sourcePath = path.join(dir, `source-${name}.jsonl`);
      const cleanedPath = path.join(dir, `cleaned-${name}.jsonl`);
      writeFileSync(sourcePath, cr(readFileSync(WORDS, 'utf8')).replace(/\n/g, eol));
      const auditInput = deriveAuditWords(sourcePath, cleanedPath);
      assert.equal(auditInput.records, 28_415);
      assert.deepEqual(auditInput.statusPages, [3]);

      const cleaned = readFileSync(cleanedPath, 'utf8').trimEnd().split('\n');
      const source = readFileSync(sourcePath, 'utf8')
        .trimEnd()
        .split('\n')
        .filter((line) => line.replace(/\r$/, '') !== EMPTY_PAGE_STATUS);
      assert.deepEqual(cleaned, source, 'the derived dump must preserve every JSON record verbatim');

      const geometry = readFileSync(WORDS_GEO, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { page: number; text: string });
      assert.equal(cleaned.length, geometry.length);
      for (const [index, line] of cleaned.entries()) {
        const word = JSON.parse(line) as { page: number; text: string };
        assert.deepEqual(word, { page: geometry[index].page, text: geometry[index].text }, `word record ${index + 1} must stay aligned with geometry`);
      }
    });
  }

  it('rejects unexpected status and malformed JSON lines', () => {
    const invalidDir = scratchDir('real-replay-invalid-');
    const source = path.join(invalidDir, 'words.jsonl');
    const output = path.join(invalidDir, 'clean.jsonl');
    try {
      writeFileSync(source, `${JSON.stringify({ page: 1, text: 'word' })}\np4: Vision recognized no text, page emitted with no OCR text\n`);
      assert.throws(() => deriveAuditWords(source, output), /unexpected non-JSON line 2/);
      writeFileSync(source, `${JSON.stringify({ page: 1, text: 'word' })}\n{not json}\n`);
      assert.throws(() => deriveAuditWords(source, output), /unexpected non-JSON line 2/);
    } finally {
      safeRmSync(invalidDir, { recursive: true, force: true });
    }
  });

  it('runs cleanly over the full 100-page dump', () => {
    assert.equal(status, 0, stderr);
    assert.ok(md.length > 150_000, `expected > 150,000 chars, got ${md.length}`);
  });

  it('severity-1: MISSING=0 via the shipped auditor', () => {
    const tmp = path.join(dir, 'replayed.md');
    writeFileSync(tmp, md);
    const result = auditWords(auditWordsPath, tmp);
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
