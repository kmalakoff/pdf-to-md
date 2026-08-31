// ocr-path.test.ts — OCR path (tesseract.js engine), fixtures 3-5: image-only PDFs (see
// test/lib/make-fixtures.ts), so assertions allow for case differences rather than byte-exact text.

import assert from 'node:assert/strict';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';

function hasWord(md: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, 'i').test(md);
}

describe('OCR path: ocr-single.pdf', () => {
  const result = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--json']);
  const report = expectReport(result);
  const { md } = result;

  it('recognizes every expected word', () => {
    // 'creative' is excluded here — it's a line-final OCR hyphen split ("creat-" / "ive")
    // whose rejoin depends on the bundled dictionary.
    for (const w of ['Mountain', 'Journal', 'valley', 'clouds', 'hiker', 'climb', 'birds', 'camp', 'gear']) {
      assert.ok(hasWord(md, w), `expected word "${w}" not found in OCR output`);
    }
  });

  it('recognizes the dictionary-dependent word ("creative")', () => {
    assert.ok(hasWord(md, 'creative'), 'expected word "creative" not found in OCR output');
  });

  it('detects the display heading', () => {
    assert.match(md, /^#+\s*Mountain Journal\s*$/im);
  });

  it('joins each paragraph onto a single line (no hard-wrap artifacts)', () => {
    assert.match(md, /valley stretched beneath the morning clouds and pine trees\.?/i);
    assert.match(md, /birds circled slowly above the camp as hikers packed their gear\.?/i);
  });

  it('joins the hyphen-split paragraph onto a single line', () => {
    assert.match(md, /hiker needs a spark of creative energy before the steep climb\.?/i);
  });

  it('closes the OCR line-final hyphen ("creat-" + "ive" -> "creative")', () => {
    assert.doesNotMatch(md, /creat-\s*ive/i);
    assert.match(md, /creative/i);
  });

  it('reports a sane QA summary', () => {
    assert.equal(report.junkHeadings, 0);
    assert.equal(report.headings, 1);
    assert.equal(report.paragraphs, 3);
  });
});

describe('OCR path: ocr-twocol.pdf', () => {
  const { md } = run([fixturePath('ocr-twocol.pdf'), '--stdout', '--ocr']);

  it('recognizes words from both columns, including the near-gutter line', () => {
    for (const w of ['Bread', 'closing', 'market', 'stalls', 'prices', 'Sailors', 'noon', 'harbor', 'catch', 'dock']) {
      assert.ok(hasWord(md, w), `expected word "${w}" not found in OCR output`);
    }
  });

  it('de-braids the two columns without interleaving lines mid-sentence', () => {
    const left = md.indexOf('Bread was sold near closing');
    const leftEnd = md.indexOf('Vendors called out prices');
    const right = md.indexOf('Sailors docked before noon');
    assert.ok(left >= 0 && leftEnd >= 0 && right >= 0, 'expected column content missing');
    assert.ok(left < leftEnd && leftEnd < right, 'left column should be fully emitted before the right column starts');
  });

  it('joins each multi-line paragraph onto one line', () => {
    assert.match(md, /Bread was sold near closing\.?\s+Crowds filled the market\.?\s+Bakers closed the stalls\.?/i);
    assert.match(md, /Sailors docked before noon\.?\s+Gulls circled the harbor pier\.?\s+Fishermen sorted the catch\.?/i);
  });
});

describe('OCR path: ocr-badge.pdf', () => {
  const result = run([fixturePath('ocr-badge.pdf'), '--stdout', '--ocr', '--json']);
  const report = expectReport(result);
  const { md } = result;

  it('recognizes the body paragraph words and the heading', () => {
    // 'creative' excluded — same hyphen-split reason as ocr-single.pdf's test above.
    for (const w of ['Trail', 'Guide', 'Campers', 'bridge', 'spirit', 'Sunlight', 'summit']) {
      assert.ok(hasWord(md, w), `expected word "${w}" not found in OCR output`);
    }
    assert.match(md, /^#+\s*Trail Guide\s*$/im);
  });

  it('recognizes the dictionary-dependent word ("creative")', () => {
    assert.ok(hasWord(md, 'creative'), 'expected word "creative" not found in OCR output');
  });

  it('excludes the decorative badge from body prose', () => {
    const bodyLines = md.split('\n').filter((l) => !l.trim().startsWith('>'));
    const body = bodyLines.join('\n');
    assert.doesNotMatch(body, /SAMPLE BADGE TEXT/i);
  });

  it('keeps the badge text recoverable as a float aside', () => {
    assert.match(md, /^>\s*\[floats\].*SAMPLE BADGE TEXT/im);
  });

  it('keeps body paragraphs intact around the excluded badge', () => {
    assert.match(md, /Campers followed the marked trail past the old stone bridge today\.?/i);
    assert.match(md, /Sunlight filtered through the pines as the trail wound toward the summit\.?/i);
  });

  it('keeps the hyphen-split paragraph intact around the excluded badge', () => {
    assert.match(md, /Every group needs a spark of creative spirit for the final climb\.?/i);
  });

  it('reports the float and no junk headings', () => {
    assert.equal(report.junkHeadings, 0);
    assert.equal(report.floats, 1);
    assert.equal(report.paragraphs, 3);
  });
});
