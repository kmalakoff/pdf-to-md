// raster.test.ts — renderPageToPNG's library error contract (src/raster.ts): a missing file
// and an out-of-range page are typed PdfToMdErrors, not raw exceptions.

import assert from 'node:assert/strict';
import { PdfToMdError, renderPageToPNG } from '@effortlessmotion/pdf-to-md';
import { fixturePath } from '../lib/fixtures.ts';

describe('renderPageToPNG: library error contract', () => {
  it('throws PdfToMdError code PDF_OPEN for a missing file', async () => {
    await assert.rejects(renderPageToPNG('/nonexistent/does-not-exist.pdf', 1, 200), (err: unknown) => err instanceof PdfToMdError && err.code === 'PDF_OPEN');
  });

  it('throws PdfToMdError code PAGE_RANGE for a page outside the document', async () => {
    await assert.rejects(renderPageToPNG(fixturePath('text-single.pdf'), 5, 200), (err: unknown) => err instanceof PdfToMdError && err.code === 'PAGE_RANGE');
  });
});
