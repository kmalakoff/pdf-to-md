// api.test.ts — direct-import coverage of the public library API. Imports from src/index.ts
// (never bin/), proving the library path carries no CLI dependency (no argv, no process.exit, no console output). Subprocess tests elsewhere (test/lib/run.ts) cover the CLI contract.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OcrProgressEvent, OcrWordInput } from '@effortlessmotion/pdf-to-md';
import { analyze, extractOcr, extractText, PdfToMdError, pdfToMarkdown } from '@effortlessmotion/pdf-to-md';
import { fixturePath } from '../lib/fixtures.ts';
import { TMP_ROOT } from '../lib/tmp.ts';

interface DumpWord {
  page: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Lay one visual line of words: fixed per-word width + gap, shared y/h.
 * Same construction as test/unit/column-break.test.ts's dumpLine helper. */
function dumpLine(page: number, y: number, xStart: number, text: string, h = 0.017): DumpWord[] {
  const words = text.split(' ');
  const step = 0.062;
  return words.map((t, i) => ({
    page,
    text: t,
    x: xStart + i * step,
    y,
    w: 0.052,
    h,
  }));
}

describe('extractText: text-single.pdf', () => {
  it('returns { markdown, report, warnings } with the fixture content', async () => {
    const { markdown, report, warnings } = await extractText(fixturePath('text-single.pdf'));
    assert.match(markdown, /^# Garden Notes$/m);
    assert.match(markdown, /The morning sun crossed the quiet garden slowly while silver dew still rested on the grass\./);
    assert.equal(report.junkHeadings, 0);
    assert.ok(Array.isArray(warnings));
  });
});

describe('pdfToMarkdown: ocr-single.pdf with { ocr: true }', () => {
  it('reports path "ocr", recognizes the fixture text, and delivers page progress events', async () => {
    const progress: OcrProgressEvent[] = [];
    const { markdown, report } = await pdfToMarkdown(fixturePath('ocr-single.pdf'), {
      ocr: true,
      onProgress: (e) => progress.push(e),
    });
    assert.equal(report.path, 'ocr');
    assert.match(markdown, /Mountain Journal/i);
    assert.ok(
      progress.some((e) => e.type === 'page'),
      `expected at least one {type: 'page'} progress event, got ${JSON.stringify(progress)}`
    );
  });
});

describe('pdfToMarkdown: ocr-single.pdf with no options', () => {
  it('auto-falls-back to OCR and reports the fallback in report and warnings', async () => {
    const { report, warnings } = await pdfToMarkdown(fixturePath('ocr-single.pdf'));
    assert.equal(report.path, 'ocr');
    assert.equal(report.ocrFallback, true);
    assert.match(warnings[0], /falling back to OCR/i);
  });
});

describe('extractOcr: words replay', () => {
  it('assembles a tiny in-memory word dump into markdown in reading order', async () => {
    const words = [...dumpLine(1, 0.8, 0.1, 'The quiet valley'), ...dumpLine(1, 0.75, 0.1, 'welcomed the morning light.')];
    const { markdown } = await extractOcr({ words });
    const firstIdx = markdown.indexOf('quiet');
    const secondIdx = markdown.indexOf('welcomed');
    assert.ok(firstIdx >= 0, 'expected first line words in markdown');
    assert.ok(secondIdx >= 0, 'expected second line words in markdown');
    assert.ok(firstIdx < secondIdx, 'expected reading order (first line before second)');
    for (const w of ['quiet', 'valley', 'welcomed', 'morning', 'light']) {
      assert.match(markdown, new RegExp(`\\b${w}\\b`, 'i'));
    }
  });

  // Sample is sorted ascending by confidence BEFORE capping, not appearance order — otherwise a
  // chart-heavy page could cap out on mild offenders while the actually-worst tokens fell past the cap.
  it('lowConfidenceSample: sorted worst-confidence-first, not appearance order', async () => {
    const words: OcrWordInput[] = [
      { page: 1, text: 'alpha', x: 0.1, y: 0.8, w: 0.05, h: 0.017, confidence: 55 },
      { page: 1, text: 'bravo', x: 0.2, y: 0.8, w: 0.05, h: 0.017, confidence: 10 },
      { page: 1, text: 'charlie', x: 0.3, y: 0.8, w: 0.05, h: 0.017, confidence: 40 },
      { page: 1, text: 'delta', x: 0.4, y: 0.8, w: 0.05, h: 0.017, confidence: 0 },
      // a genuine prose word so this page reads as ordinary prose, not a review block — only
      // sample ORDERING is under test here.
      { page: 1, text: 'quietly', x: 0.5, y: 0.8, w: 0.06, h: 0.017, confidence: 95 },
    ];
    const { report } = await extractOcr({ words });
    assert.equal(report.path, 'ocr');
    assert.equal(report.pageStats[0].lowConfidenceWords, 4);
    assert.deepEqual(report.pageStats[0].lowConfidenceSample, ['delta', 'bravo', 'charlie', 'alpha'], 'expected ascending-confidence order (0, 10, 40, 55), not insertion order');
  });

  it('rejects malformed words input (missing x) with PdfToMdError code WORDS_INPUT', async () => {
    const malformed = [{ page: 1, text: 'hello', y: 0.5, w: 0.05, h: 0.02 }] as unknown as OcrWordInput[];
    await assert.rejects(
      () => extractOcr({ words: malformed }),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError, 'expected a PdfToMdError');
        assert.equal((err as PdfToMdError).code, 'WORDS_INPUT');
        return true;
      }
    );
  });
});

// Error-contract coverage: every documented failure mode must surface as a typed PdfToMdError
// with the right code, never a raw Node/pdfjs error; the library must never write to stdout/stderr (verified against process.stderr directly, not just the return value).
describe('pdfToMarkdown: error contract', () => {
  it('missing file: PdfToMdError/PDF_OPEN, not a raw ENOENT Error', async () => {
    await assert.rejects(
      () => pdfToMarkdown('/does/not/exist/nope.pdf'),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError, `expected a PdfToMdError, got ${(err as Error).name}: ${(err as Error).message}`);
        assert.equal((err as PdfToMdError).code, 'PDF_OPEN');
        return true;
      }
    );
  });

  it('non-PDF file: PdfToMdError/PDF_OPEN, not a raw/uncoded InvalidPDFException', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const notAPdf = path.join(TMP_ROOT, 'not-a-pdf.pdf');
    writeFileSync(notAPdf, 'this is not a pdf');
    try {
      await assert.rejects(
        () => pdfToMarkdown(notAPdf),
        (err: unknown) => {
          assert.ok(err instanceof PdfToMdError, `expected a PdfToMdError, got ${(err as Error).name}: ${(err as Error).message}`);
          assert.equal((err as PdfToMdError).code, 'PDF_OPEN');
          // the original pdfjs message survives as debugging context
          assert.match((err as PdfToMdError).message, /invalid pdf/i);
          return true;
        }
      );
    } finally {
      rmSync(notAPdf, { force: true });
    }
  });

  it('never writes to stdout/stderr, even on a broken/non-PDF input (pdfjs verbosity silenced)', async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const notAPdf = path.join(TMP_ROOT, 'not-a-pdf-2.pdf');
    writeFileSync(notAPdf, 'also not a pdf');
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    let wrote = false;
    process.stderr.write = ((...args: unknown[]) => {
      wrote = true;
      return origErr(...(args as Parameters<typeof origErr>));
    }) as typeof process.stderr.write;
    process.stdout.write = ((...args: unknown[]) => {
      wrote = true;
      return origOut(...(args as Parameters<typeof origOut>));
    }) as typeof process.stdout.write;
    try {
      await assert.rejects(() => pdfToMarkdown(notAPdf));
    } finally {
      process.stderr.write = origErr;
      process.stdout.write = origOut;
      rmSync(notAPdf, { force: true });
    }
    assert.equal(wrote, false, 'expected zero stdout/stderr writes from the library layer');
  });

  it('wrong-typed pages option (CLI-style string instead of {first, last?}): PdfToMdError/PAGE_RANGE, not silently ignored', async () => {
    await assert.rejects(
      // @ts-expect-error deliberately wrong shape — the JS-caller case TypeScript can't catch
      () => pdfToMarkdown(fixturePath('text-single.pdf'), { pages: 'abc' }),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError, `expected a PdfToMdError, got ${(err as Error).name}: ${(err as Error).message}`);
        assert.equal((err as PdfToMdError).code, 'PAGE_RANGE');
        return true;
      }
    );
  });
});

// Same class of JS-caller mistake as WORDS_INPUT/PAGE_RANGE above, for extractOcr's/analyze()'s
// `input` union: a plain-JS caller (TypeScript catches it at compile time) got a raw TypeError before this fix.
describe('extractOcr/analyze: input-shape error contract', () => {
  it("extractOcr('book.pdf') (bare path, extractText-shaped mistake): PdfToMdError/PDF_OPEN, not a raw TypeError", async () => {
    await assert.rejects(
      // @ts-expect-error deliberately wrong shape — the JS-caller case TypeScript can't catch
      () => extractOcr('book.pdf'),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError, `expected a PdfToMdError, got ${(err as Error).constructor.name}: ${(err as Error).message}`);
        assert.equal((err as PdfToMdError).code, 'PDF_OPEN');
        return true;
      }
    );
  });

  it('extractOcr(null): PdfToMdError/WORDS_INPUT, not a raw TypeError', async () => {
    await assert.rejects(
      // @ts-expect-error deliberately wrong shape — the JS-caller case TypeScript can't catch
      () => extractOcr(null),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError, `expected a PdfToMdError, got ${(err as Error).constructor.name}: ${(err as Error).message}`);
        assert.equal((err as PdfToMdError).code, 'WORDS_INPUT');
        return true;
      }
    );
  });

  it('analyze(null): PdfToMdError/WORDS_INPUT, not a raw TypeError', async () => {
    await assert.rejects(
      // @ts-expect-error deliberately wrong shape — the JS-caller case TypeScript can't catch
      () => analyze(null),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError, `expected a PdfToMdError, got ${(err as Error).constructor.name}: ${(err as Error).message}`);
        assert.equal((err as PdfToMdError).code, 'WORDS_INPUT');
        return true;
      }
    );
  });

  it('analyze(123): PdfToMdError/WORDS_INPUT, not a raw TypeError', async () => {
    await assert.rejects(
      // @ts-expect-error deliberately wrong shape — the JS-caller case TypeScript can't catch
      () => analyze(123),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError, `expected a PdfToMdError, got ${(err as Error).constructor.name}: ${(err as Error).message}`);
        assert.equal((err as PdfToMdError).code, 'WORDS_INPUT');
        return true;
      }
    );
  });
});
