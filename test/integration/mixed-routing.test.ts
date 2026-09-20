import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pdfToMarkdown } from '@effortlessmotion/pdf-to-md';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { PDFDocument } from 'pdf-lib';
import { fixturePath } from '../lib/fixtures.ts';
import { expectReport, run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

const fixture = fixturePath('mixed-text-ocr.pdf');

describe('mixed page routing', () => {
  it('leaves blank and vector-only pages on text with uncertainty warnings', async () => {
    const dir = scratchDir('blank-routing-');
    try {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      doc.addPage([612, 792]).drawRectangle({ x: 50, y: 50, width: 100, height: 100 });
      const file = path.join(dir, 'blank-vector.pdf');
      writeFileSync(file, await doc.save());
      let callbacks = 0;
      const result = await pdfToMarkdown(file, {
        onWords: (words) => {
          callbacks++;
          assert.deepEqual(words, []);
        },
      });
      assert.equal(result.report.path, 'text');
      assert.deepEqual(
        result.report.pageStats.map((page) => page.path),
        ['text', 'text']
      );
      assert.equal(callbacks, 1);
      for (const page of [1, 2]) assert.ok(result.warnings.some((warning) => warning.startsWith(`p${page}: no extractable text;`) && /blank.*vector/.test(warning)));
      assert.ok(result.warnings.every((warning) => !/using OCR/.test(warning)));
    } finally {
      safeRmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps usable text, OCRs the image page, and calls onWords once for the selected result', async () => {
    const calls: { page: number; text: string }[][] = [];
    const result = await pdfToMarkdown(fixture, { onWords: (words) => calls.push(words) });
    assert.equal(result.report.path, 'mixed');
    assert.deepEqual(
      result.report.pageStats.map((page) => [page.page, page.path]),
      [
        [1, 'text'],
        [2, 'ocr'],
      ]
    );
    assert.match(result.markdown, /Harbor Record/);
    assert.match(result.markdown, /Mountain Journal/i);
    assert.equal(result.report.chars, result.markdown.length);
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].some((word) => word.page === 1 && /Harbor Record/.test(word.text)),
      'text-run evidence missing'
    );
    assert.ok(
      calls[0].some((word) => word.page === 2 && /Mountain/i.test(word.text)),
      'OCR evidence missing'
    );
  });

  it('keeps original page numbering when a selected image page routes to OCR', () => {
    const result = run([fixture, '--pages', '2', '--stdout', '--json']);
    const report = expectReport(result);
    assert.equal(report.path, 'ocr');
    assert.deepEqual(
      report.pageStats.map((page) => page.page),
      [2]
    );
    assert.match(result.md, /^### p2$/m);
    assert.doesNotMatch(result.md, /Harbor Record/);
  });

  it('routes raw and plain-text CLI output through the same page producers', () => {
    const raw = run([fixture, '--stdout', '--format=raw']);
    assert.equal(raw.status, 0, raw.stderr);
    const analysis = JSON.parse(raw.stdout);
    assert.equal(analysis.report.path, 'mixed');
    assert.deepEqual(
      analysis.pages.map((page: { page: number; path: string }) => [page.page, page.path]),
      [
        [1, 'text'],
        [2, 'ocr'],
      ]
    );

    const text = run([fixture, '--stdout', '--format=txt', '--json']);
    const report = expectReport(text);
    assert.equal(report.path, 'mixed');
    assert.match(text.md, /Harbor Record/);
    assert.match(text.md, /Mountain Journal/i);
  });
});
