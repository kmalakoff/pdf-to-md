// audit.test.ts — src/audit.ts: fast, inline-fixture coverage of the shipped auditor (auditWords);
// the real acceptance check runs against the real-OCR baseline in real-replay.test.ts.

// Worth a fast unit test: the auditor's own logic reads a tiny jsonl+markdown pair correctly
// (0 missing), and actually detects an artificially deleted word rather than silently reporting 0.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeRmSync } from 'fs-remove-compat';
import { auditWords } from '@effortlessmotion/pdf-to-md';
import { scratchDir } from '../lib/tmp.ts';

const WORDS = [
  { page: 1, text: 'Hello' },
  { page: 1, text: 'World' },
  { page: 2, text: 'Foo' },
  { page: 2, text: 'bar-baz' },
]
  .map((o) => JSON.stringify(o))
  .join('\n');

const MD = ['### p1', 'Hello World', '', '### p2', 'Foo bar-baz', ''].join('\n');

function withFixtures(words: string, md: string, fn: (wordsPath: string, mdPath: string) => void): void {
  const dir = scratchDir('audit-words-test-');
  try {
    const wordsPath = path.join(dir, 'words.jsonl');
    const mdPath = path.join(dir, 'doc.md');
    writeFileSync(wordsPath, words);
    writeFileSync(mdPath, md);
    fn(wordsPath, mdPath);
  } finally {
    safeRmSync(dir, { recursive: true, force: true });
  }
}

describe('auditWords (src/audit.ts)', () => {
  it('reports 0 missing when every recognized word is present', () => {
    withFixtures(WORDS, MD, (wordsPath, mdPath) => {
      const result = auditWords(wordsPath, mdPath);
      assert.equal(result.parsed, 4);
      assert.equal(result.nonJsonSkipped, 0);
      assert.equal(result.pages, 2);
      assert.equal(result.missing, 0);
      assert.deepEqual(result.perPage, []);
    });
  });

  it('fires on exactly the deleted word', () => {
    const injected = MD.replace('Hello World', 'World'); // drop "Hello" from p1
    withFixtures(WORDS, injected, (wordsPath, mdPath) => {
      const result = auditWords(wordsPath, mdPath);
      assert.equal(result.missing, 1);
      assert.equal(result.perPage.length, 1);
      assert.equal(result.perPage[0].page, 1);
      assert.deepEqual(result.perPage[0].missing, ['hello']);
    });
  });
});
