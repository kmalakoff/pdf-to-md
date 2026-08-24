// pdf-open.ts — the one seam that opens a PDF via pdfjs-dist, in the two
// shapes callers need: openDocument (data-based, already-open doc) and openPdfForRender (url-based, task you must await + destroy()).
// Both wrap a failure the same way: PdfToMdError/PDF_OPEN, original message preserved.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfToMdError } from './errors.ts';
import { resolvePackagePath } from './resolve.ts';

// `verbosity: VerbosityLevel.ERRORS` silences pdfjs's own console.warn calls
// — the library's documented promise is it never writes to stdout/stderr on its own.

/** Data-based open (collect.ts's seam): no cMaps/fonts — text-layer extraction
 * only, verified to decode CJK correctly. Wraps missing/unreadable and non-PDF files as PdfToMdError/PDF_OPEN. */
export async function openDocument(src: string): Promise<PDFDocumentProxy> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(readFileSync(src));
  } catch (err) {
    throw new PdfToMdError('PDF_OPEN', `cannot read ${src}: ${(err as Error).message}`);
  }
  try {
    return await getDocument({
      data,
      useSystemFonts: true,
      verbosity: VerbosityLevel.ERRORS,
    }).promise;
  } catch (err) {
    throw new PdfToMdError('PDF_OPEN', `cannot open ${src} as a PDF: ${(err as Error).message}`);
  }
}

// Wires up pdfjs's bundled cmaps/standard_fonts so CJK and non-embedded
// standard fonts resolve instead of falling back to substitute glyphs.
//
// GOTCHA: despite the `...Url` name, pdfjs's Node loader does `fs.readFile`
// on the string directly — a `file://` URL silently fails every lookup (only a stderr warning); plain filesystem paths are required.
// The trailing "/" must be literal (pdfjs rejects a trailing "\"); Windows' fs accepts "/" after a "\" path.
const PDFJS_DIST_ROOT = path.dirname(resolvePackagePath('pdfjs-dist/package.json'));
const CMAP_URL = `${path.join(PDFJS_DIST_ROOT, 'cmaps')}/`;
const STANDARD_FONT_DATA_URL = `${path.join(PDFJS_DIST_ROOT, 'standard_fonts')}/`;
// JBIG2/JPEG2000 decoding lives in pdfjs's WASM modules: without this, bitonal
// scans (the usual encoding for B&W page images) decode to a BLANK page and OCR sees nothing.
const WASM_URL = `${path.join(PDFJS_DIST_ROOT, 'wasm')}/`;

/**
 * Open a PDF for rendering (raster.ts/tesseract.ts's seam): cMaps + standard
 * fonts wired up, url-based. Callers must `await` the returned task's `.promise` (via `awaitPdfOpen`) and call `.destroy()` when done.
 */
export function openPdfForRender(pdfPath: string): PDFDocumentLoadingTask {
  // No `worker` option: this pdfjs-dist Node build needs no real Worker thread wired up to run.
  return getDocument({
    url: pdfPath,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    wasmUrl: WASM_URL,
    verbosity: VerbosityLevel.ERRORS,
  });
}

/** Shared error wrapping for `openPdfForRender`'s task: a raw pdfjs open
 * failure becomes PdfToMdError/PDF_OPEN, original message preserved. */
export async function awaitPdfOpen(loadingTask: PDFDocumentLoadingTask, pdfPath: string): Promise<PDFDocumentProxy> {
  try {
    return await loadingTask.promise;
  } catch (err) {
    throw new PdfToMdError('PDF_OPEN', `could not open PDF: ${pdfPath} (${(err as Error).message})`);
  }
}
