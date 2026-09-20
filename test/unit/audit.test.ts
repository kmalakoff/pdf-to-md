// audit.test.ts — src/audit.ts: fast, inline-fixture coverage of the shipped auditor (auditWords);
// the real acceptance check runs against the real-OCR baseline in real-replay.test.ts.

// Worth a fast unit test: the auditor's own logic reads a tiny jsonl+markdown pair correctly
// (0 missing), and actually detects an artificially deleted word rather than silently reporting 0.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { auditWords, PdfToMdError } from '@effortlessmotion/pdf-to-md';
import { safeRmSync } from 'fs-remove-compat';
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

  it('tokenizes multiword source runs and preserves Unicode letters and numbers', () => {
    const words = JSON.stringify({ page: 1, text: 'Héllo שלום ٢٠٢٦' });
    withFixtures(words, '<!-- p1 -->\nHéllo שלום ٢٠٢٦\n', (wordsPath, mdPath) => {
      const result = auditWords(wordsPath, mdPath);
      assert.equal(result.words, 3);
      assert.equal(result.missing, 0, result.summaryLine);
    });
  });

  it('does not reuse an output occurrence or accept a substring', () => {
    const repeated = [JSON.stringify({ page: 1, text: 'echo' }), JSON.stringify({ page: 1, text: 'echo' })].join('\n');
    withFixtures(repeated, '### p1\necho\n', (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['echo'] }]);
    });
    withFixtures(JSON.stringify({ page: 1, text: 'he' }), '### p1\nthe\n', (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['he'] }]);
    });
  });

  it('reports missing Unicode text instead of deleting it during normalization', () => {
    withFixtures(JSON.stringify({ page: 1, text: 'שלום' }), '### p1\n\n', (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['שלום'] }]);
    });
  });

  it('uses the extraction typography fold for modifier-letter apostrophes', () => {
    withFixtures(JSON.stringify({ page: 1, text: 'donʼt' }), "### p1\ndon't\n", (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 0);
    });
  });

  it('repairs only explicit source and Markdown line hyphen boundaries', () => {
    const terminal = [JSON.stringify({ page: 1, text: 'creat-' }), JSON.stringify({ page: 1, text: 'ive' })].join('\n');
    withFixtures(terminal, '### p1\ncreative\n', (wordsPath, mdPath) => {
      const result = auditWords(wordsPath, mdPath);
      assert.equal(result.strictDeficits, 2);
      assert.equal(result.missing, 0, result.summaryLine);
    });
    const standalone = [JSON.stringify({ page: 1, text: 'creat' }), JSON.stringify({ page: 1, text: '-' }), JSON.stringify({ page: 1, text: 'ive' })].join('\n');
    withFixtures(standalone, '### p1\ncreative\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 0);
    });
    withFixtures(JSON.stringify({ page: 1, text: 'creative' }), '### p1\ncreat-\nive\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 0);
    });
    withFixtures(JSON.stringify({ page: 1, text: 'creative' }), '### p1\ncreat-ive\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 1);
    });
    const fragments = [JSON.stringify({ page: 1, text: 'creat' }), JSON.stringify({ page: 1, text: 'ive' })].join('\n');
    withFixtures(fragments, '### p1\ncreative\n', (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['creat', 'ive'] }]);
    });
    const touching = [JSON.stringify({ page: 1, text: 'mor', x: 0, y: 10, w: 3, h: 1 }), JSON.stringify({ page: 1, text: 'ning', x: 3, y: 10, w: 4, h: 1 })].join('\n');
    withFixtures(touching, '### p1\nmorning\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 0);
    });
    const separated = [JSON.stringify({ page: 1, text: 'mor', x: 0, y: 10, w: 40, h: 1 }), JSON.stringify({ page: 1, text: 'ning', x: 46, y: 11, w: 40, h: 1 })].join('\n');
    withFixtures(separated, '### p1\nmorning\n', (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['mor', 'ning'] }]);
    });
    const spaced = [JSON.stringify({ page: 1, text: 'mor ', x: 0, y: 10, w: 3, h: 1 }), JSON.stringify({ page: 1, text: 'ning', x: 3, y: 10, w: 4, h: 1 })].join('\n');
    withFixtures(spaced, '### p1\nmorning\n', (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['mor', 'ning'] }]);
    });
  });

  it('uses visible hyphen evidence before plain joined occurrences', () => {
    const words = ['swastika', 'swastika', 'swas', '-', 'tika'].map((text) => JSON.stringify({ page: 1, text })).join('\n');
    withFixtures(words, '### p1\nswastika swas-tika\n', (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['swastika'] }]);
    });
    const complete = ['swastika', 'swastika', 'swastika', 'swas', '-', 'tika'].map((text) => JSON.stringify({ page: 1, text })).join('\n');
    withFixtures(complete, '### p1\nswastika swastika swastika swas-tika\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 0);
    });
  });

  it('allocates separate joined and visible-hyphen occurrences without reuse', () => {
    const words = ['counter', '-', 'clockwise', 'counter-clockwise'].map((text) => JSON.stringify({ page: 1, text })).join('\n');
    withFixtures(words, '### p1\ncounterclockwise counter-clockwise\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 0);
    });
  });

  it('never turns complete literal counts into a deficit through competing repairs', () => {
    const words = ['a-', 'b', 'ab-', 'c'].map((text) => JSON.stringify({ page: 1, text })).join('\n');
    withFixtures(words, '### p1\na b ab c\n', (wordsPath, mdPath) => {
      const result = auditWords(wordsPath, mdPath);
      assert.equal(result.strictDeficits, 0);
      assert.equal(result.missing, 0, result.summaryLine);
    });
  });

  it('does not treat image or link destinations as text but keeps rendered URLs', () => {
    const word = JSON.stringify({ page: 1, text: 'secret' });
    withFixtures(word, '### p1\n![scan](https://example.test/secret.png)\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 1);
    });
    withFixtures(word, '### p1\n[scan](https://example.test/secret)\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 1);
    });
    withFixtures(word, '### p1\n[scan][secret]\n[secret]: https://example.test/secret\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 1);
    });
    withFixtures(word, '### p1\nhttps://example.test/secret\n', (wordsPath, mdPath) => {
      assert.equal(auditWords(wordsPath, mdPath).missing, 0);
    });
  });

  it('does not treat generated labels, comments, or image paths as page text', () => {
    const words = ['review', 'unstructured', 'labels', 'floats', 'hidden', 'path'].map((text) => JSON.stringify({ page: 1, text })).join('\n');
    const md = '### p1\n> [review: unstructured labels]\n> [floats]\n<!-- hidden -->\n![scan](image-path.png)\n';
    withFixtures(words, md, (wordsPath, mdPath) => {
      assert.deepEqual(auditWords(wordsPath, mdPath).perPage, [{ page: 1, missing: ['review', 'unstructured', 'labels', 'floats', 'hidden', 'path'] }]);
    });
  });

  it('rejects empty, malformed, and unmarked evidence', () => {
    const cases: { words: string; md: string; message: RegExp }[] = [
      { words: '', md: '### p1\ntext\n', message: /no JSON records/ },
      { words: '{not json}\n', md: '### p1\ntext\n', message: /line 1 is not valid JSON/ },
      { words: JSON.stringify({ page: 0, text: 'text' }), md: '### p1\ntext\n', message: /positive integer page/ },
      { words: JSON.stringify({ page: 1, text: '' }), md: '### p1\ntext\n', message: /non-empty text/ },
      { words: JSON.stringify({ page: 1, text: '-' }), md: '### p1\ntext\n', message: /no lexical tokens/ },
      { words: JSON.stringify({ page: 2, text: 'text' }), md: '### p1\ntext\n', message: /no provenance marker for p2/ },
    ];
    for (const { words, md, message } of cases) {
      withFixtures(words, md, (wordsPath, mdPath) => {
        assert.throws(
          () => auditWords(wordsPath, mdPath),
          (error: unknown) => error instanceof PdfToMdError && error.code === 'AUDIT_INPUT' && message.test(error.message)
        );
      });
    }
  });
});
