// engines/tesseract.ts — THE OCR engine: tesseract.js on every platform.
//
// Seam contract: words come back in normalized 0-1 page coordinates, origin
// bottom-left, y increasing upward — the y-flip happens here, and nowhere else.
//
// Pure WASM, in-process, no native dependency: no crash containment needed.
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page as TesseractPage } from 'tesseract.js';
import { createWorker, PSM } from 'tesseract.js';
import type { PageWord, Word } from '../geometry.ts';
import { foldTypographic } from '../lines.ts';
import { awaitPdfOpen, openPdfForRender } from '../pdf-open.ts';
import { renderLoadedPage } from '../raster.ts';
import { resolvePackagePath } from '../resolve.ts';

// tesseract.js writes its decompressed traineddata cache into the user's cwd by
// default; keep it in the module's fixed home store instead, where the OS never wipes it.
export const ENGINE_CACHE_DIR = path.join(os.homedir(), '.pdf-to-md', 'engine');

// 288 dpi: the render resolution the engine's word-overlap numbers were
// measured at (test/fixtures/ocr-engine-poc/) — the known-good operating point.
export const OCR_RENDER_DPI = 288;

// Chart pages starve PSM.AUTO (unrecognized text can't be marked for review).
// Prose-fraction retry trigger, measured (sparse-retry.test.ts): chart 0.442 vs prose 0.767-0.938, cut 0.6.
export const SPARSE_RETRY_PROSE_FRACTION = 0.6;

/** Share of `words` whose text contains a run of 3+ letters (`src/emit.ts`'s isUnstructured canary, applied per-page instead of per-block). */
function proseFraction(words: { text: string }[]): number {
  if (words.length === 0) return 0;
  return words.filter((w) => /[A-Za-z]{3}/.test(w.text)).length / words.length;
}

/** Does this page's PSM.AUTO pass look chart-like enough to re-recognize
 * with PSM.SPARSE_TEXT? A page with 0 words never retries (nothing to take a prose fraction of). */
export function shouldRetrySparse(words: { text: string }[]): boolean {
  return words.length > 0 && proseFraction(words) < SPARSE_RETRY_PROSE_FRACTION;
}

// The locally installed traineddata (npm package @tesseract.js-data/eng),
// resolved dynamically so depcheck won't flag it "unused" — it's a genuine runtime dependency, listed in .depcheckrc's `ignores`.
const TESSDATA_DIR = path.join(path.dirname(resolvePackagePath('@tesseract.js-data/eng/package.json')), '4.0.0');

/** Per-page recognition progress, delivered once per page as it finishes.
 * Engine chatter goes through `onWarning`/`warnings` instead — this is timing/count data only. */
export type OcrProgressEvent = { type: 'page'; page: number; words: number; ms: number };

export interface RecognizeResult {
  words: PageWord[];
  /** pages (1-based) where the engine returned zero words */
  emptyPages: number[];
  /** wall-clock ms per page (render + recognize), keyed by page number */
  msPerPage: Map<number, number>;
}

/** tesseract.js's nested blocks/paragraphs/lines/words -> this repo's flat Word contract (normalize + y-flip). Same shape regardless of which PSM produced `page`, so both the AUTO pass and the SPARSE_TEXT retry share it. */
function wordsFromPage(page: TesseractPage, width: number, height: number): Word[] {
  const pageWords: Word[] = [];
  for (const block of page.blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        for (const w of line.words ?? []) {
          const { x0, y0, x1, y1 } = w.bbox;
          pageWords.push({
            // Same typographic folding as the text path (src/lines.ts) — both
            // paths must agree on how a printed apostrophe is spelled.
            text: foldTypographic(w.text),
            x: x0 / width,
            y: (height - y1) / height, // y-flip: top-left px -> bottom-left normalized
            w: (x1 - x0) / width,
            h: (y1 - y0) / height,
            // Plumbed through unmodified — tesseract.js's own 0-100
            // per-word confidence. See src/report.ts's LOW_CONFIDENCE_THRESHOLD.
            confidence: w.confidence,
          });
        }
      }
    }
  }
  return pageWords;
}

// tesseract.js-core's WASM build writes native diagnostics straight to this
// process's stdout/stderr, with no override to silence them at the source.
//
// Suppression must span the whole run: worker-thread stdio arrives
// asynchronously, on later event-loop turns; the synchronous carve-out below (`withRealStdio`) is the only safe exit.
let suppressDepth = 0;
let savedStdoutWrite: typeof process.stdout.write | null = null;
let savedStderrWrite: typeof process.stderr.write | null = null;
async function withSuppressedStdio<T>(fn: () => Promise<T>): Promise<T> {
  if (suppressDepth === 0) {
    savedStdoutWrite = process.stdout.write.bind(process.stdout);
    savedStderrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  }
  suppressDepth++;
  try {
    return await fn();
  } finally {
    suppressDepth--;
    if (suppressDepth === 0) {
      if (savedStdoutWrite) process.stdout.write = savedStdoutWrite;
      if (savedStderrWrite) process.stderr.write = savedStderrWrite;
      savedStdoutWrite = null;
      savedStderrWrite = null;
    }
  }
}

/** Pierces an active `withSuppressedStdio` region SYNCHRONOUSLY to let this
 * module's own onProgress/onWarning calls through. No-op outside any suppressed region. */
function withRealStdio<T>(fn: () => T): T {
  if (suppressDepth === 0) return fn();
  const realOut = savedStdoutWrite;
  const realErr = savedStderrWrite;
  if (realOut) process.stdout.write = realOut;
  if (realErr) process.stderr.write = realErr;
  try {
    return fn();
  } finally {
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
  }
}

/** Recognize words on pages [first..last] of a PDF (renders at `dpi`,
 * default OCR_RENDER_DPI). Progress via `onProgress`; diagnostics via `onWarning` — this module never writes to stdout/stderr itself. */
export async function recognizePdf(pdfPath: string, first: number, last: number, { dpi = OCR_RENDER_DPI, onProgress, onWarning }: { dpi?: number; onProgress?: (e: OcrProgressEvent) => void; onWarning?: (message: string) => void } = {}): Promise<RecognizeResult> {
  mkdirSync(ENGINE_CACHE_DIR, { recursive: true });

  const words: PageWord[] = [];
  const emptyPages: number[] = [];
  const msPerPage = new Map<number, number>();

  // ONE continuous suppressed region for the whole run; onProgress/onWarning
  // below go through `withRealStdio`, the only sanctioned way out of it.
  await withSuppressedStdio(async () => {
    // OEM 1 (LSTM only, tesseract.js's own default): measured 99.0% recall
    // on the hard benchmark pages (2026-08-16).
    const worker = await createWorker('eng', 1, {
      langPath: TESSDATA_DIR,
      cachePath: ENGINE_CACHE_DIR,
    });
    try {
      // NOT optional: tesseract.js's own default PSM (SINGLE_BLOCK) measured
      // 3-8 percentage points worse than AUTO on two-column pages.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });

      const loadingTask = openPdfForRender(pdfPath);
      try {
        const pdf = await awaitPdfOpen(loadingTask, pdfPath);
        for (let pn = first; pn <= Math.min(last, pdf.numPages); pn++) {
          const t0 = Date.now();
          const { png, width, height } = await renderLoadedPage(pdf, pn, dpi);
          const { data } = await worker.recognize(png, {}, { blocks: true });
          let pageWords: Word[] = wordsFromPage(data, width, height);

          // Adaptive second pass: re-recognizes the SAME rendered PNG, so
          // this costs one extra recognize() call only on chart-like pages.
          if (shouldRetrySparse(pageWords)) {
            const autoFraction = proseFraction(pageWords);
            const autoWords = pageWords;
            // setParameters on the shared worker is reversible, so one
            // in-process worker can alternate PSM per page instead of paying for a second worker.
            await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
            const sparse = await worker.recognize(png, {}, { blocks: true });
            const sparseWords = wordsFromPage(sparse.data, width, height);
            await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });

            if (sparseWords.length > autoWords.length) {
              pageWords = sparseWords;
              const autoCount = autoWords.length;
              const sparseCount = sparseWords.length;
              withRealStdio(() => onWarning?.(`p${pn}: chart-like page (prose fraction ${autoFraction.toFixed(2)}) — retried with sparse-text segmentation, ${autoCount} -> ${sparseCount} words`));
            }
          }

          const ms = Date.now() - t0;
          for (const w of pageWords) words.push({ page: pn, ...w });
          if (pageWords.length === 0) emptyPages.push(pn);
          msPerPage.set(pn, ms);
          const wordCount = pageWords.length;
          withRealStdio(() => onProgress?.({ type: 'page', page: pn, words: wordCount, ms }));
        }
      } finally {
        await loadingTask.destroy();
      }
    } finally {
      await worker.terminate();
    }
  });

  return { words, emptyPages, msPerPage };
}
