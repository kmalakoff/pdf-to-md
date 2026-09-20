// The library layer for PDF -> markdown conversion: extractText/extractOcr/
// pdfToMarkdown each take plain args, return plain data, and throw PdfToMdError — no process.exit, no console.*, no file writing.
//
// Warnings are DATA: every notice is returned in `warnings` verbatim and also
// delivered incrementally via `onWarning` — the exact strings are load-bearing (the test suite asserts them).
import { buildOcrAnalysisPages } from './analyze.ts';
import { collect } from './collect.ts';
import { dictAvailable, dictUnavailableWarning } from './dict.ts';
import type { OcrProgressEvent } from './engines/tesseract.ts';
import type { PageWord, Tuning } from './geometry.ts';
import { renderPagesToMarkdown } from './render-analysis.ts';
import { AUTO_OCR_CHARS_PER_PAGE, buildOcrReport } from './report.ts';
import { buildTextAnalysis, selectCollectedPages } from './text-analysis.ts';
import type { Analysis, AnalysisPage, CollectResult, Report } from './types.ts';
import { validatePages } from './validate.ts';

export type { OcrProgressEvent } from './engines/tesseract.ts';

// A plain-JS caller (or `.ts` with `as any`) gets no compile-time check on
// `pages`, so it's validated once at runtime — see src/validate.ts's `validatePages`.

/** One recognized word with its page — the OCR replay input contract (same
 * shape as `geometry.ts`'s `PageWord`, re-exported under this module's public name). */
export type OcrWordInput = PageWord;

/** A 1-based, inclusive page range — the shape every entry point's `pages`
 * option takes (the CLI's own `--pages N[-M]` parses into this). */
export interface PageSelection {
  first: number;
  /** inclusive; defaults to `first` */
  last?: number;
}

/** extractText/extractOcr/pdfToMarkdown's common return shape. */
export interface ExtractResult {
  markdown: string;
  /** per-document and per-page QA metrics — see `Report` (`src/types.ts`) */
  report: Report;
  /** every notice also delivered incrementally via `onWarning`, collected
   * here in full (hybrid pages, auto-OCR-fallback, empty OCR pages, sparse-retry) */
  warnings: string[];
}

interface CommonOptions {
  /** convert only this page range (1-based, inclusive); defaults to the
   * whole document */
  pages?: PageSelection;
  /** delivered as each warning happens (also returned, in full, as
   * `warnings` on the resolved result) */
  onWarning?: (message: string) => void;
}

/** Options for {@link extractText}. */
export interface ExtractTextOptions extends CommonOptions {
  /** emit a `### pN` marker before each page's content (output formatting
   * only — `report.pageStats` is always populated regardless) */
  pageMarkers?: boolean;
  /** source PDF text runs entering layout, delivered once for the selected
   * final result. Runs retain measured bounds and are not fabricated words. */
  onWords?: (words: OcrWordInput[]) => void;
}

/** Options for {@link extractOcr}. */
export interface ExtractOcrOptions extends CommonOptions {
  /** override any subset of the OCR-path geometry defaults — see
   * DEFAULT_TUNING (`src/geometry.ts`) for each knob's measured default */
  tuning?: Partial<Tuning>;
  /** page-render resolution for engine recognition (default 288, measured;
   * >~400 measured WORSE on ordinary pages — not a "bigger is safer" knob) */
  dpi?: number;
  /** marks report.ocrFallback — set by pdfToMarkdown's auto-fallback */
  fallback?: boolean;
  /** one event per page as recognition finishes (timing/count only — engine
   * chatter and the sparse-retry notice arrive via `onWarning` instead) */
  onProgress?: (e: OcrProgressEvent) => void;
  /** every recognized word entering the geometry, delivered once after
   * recognition — the severity-1 audit instrument (--debug-words) */
  onWords?: (words: OcrWordInput[]) => void;
}

/** Options for {@link pdfToMarkdown}. */
export interface PdfToMarkdownOptions extends ExtractTextOptions, Omit<ExtractOcrOptions, 'fallback'> {
  /** force the OCR path even when a text layer exists */
  ocr?: boolean;
  /** never fall back to OCR, even for image-only pages */
  noOcr?: boolean;
}

// One collector per entry point: collects into `warnings`, streams via
// onWarning, and emits the dictionary-unavailable notice exactly once up front.
function warnCollector(onWarning?: (message: string) => void): { warnings: string[]; warn: (m: string) => void } {
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    onWarning?.(m);
  };
  if (!dictAvailable()) warn(dictUnavailableWarning());
  return { warnings, warn };
}

/** Extract embedded text with a QA report and warnings; never runs OCR.
 * @param pdfPath path to the PDF file
 * @param opts see {@link ExtractTextOptions}
 */
export async function extractText(pdfPath: string, opts: ExtractTextOptions = {}): Promise<ExtractResult> {
  validatePages(opts.pages);
  const { warnings, warn } = warnCollector(opts.onWarning);
  const range = opts.pages ? { first: opts.pages.first, last: opts.pages.last ?? opts.pages.first } : {};
  const collected = await collect(pdfPath, range);
  const text = buildTextAnalysis(collected, opts.pageMarkers ?? false);
  textNotices(collected, new Set(), warn);
  opts.onWords?.(text.words);
  return { markdown: text.markdown, report: text.analysis.report, warnings };
}

/**
 * OCR extraction. Input is either a PDF (pages render at `dpi` and the
 * engine recognizes them, imported lazily) or an already-recognized word dump (the offline replay input — see `--words-json`).
 *
 * @param input `{ pdfPath }` to recognize, or `{ words }` to replay a dump
 * @param opts see {@link ExtractOcrOptions}
 */
export async function extractOcr(input: { pdfPath: string } | { words: OcrWordInput[] }, opts: ExtractOcrOptions = {}): Promise<ExtractResult> {
  validatePages(opts.pages);
  const { warnings, warn } = warnCollector(opts.onWarning);

  // Shared with analyze(pdf, {path:'ocr'}) — see that module's header for
  // why this makes the two byte-identical by construction, not by hand.
  const { pages, words } = await buildOcrAnalysisPages(input, opts, warn);
  const md = renderPagesToMarkdown(pages, { forcePageMarkers: true, pageMarkers: true });

  const report = buildOcrReport({
    md,
    fallback: opts.fallback,
    // Confidence is on `words` — see report.ts's low-confidence detector for
    // how it handles a confidence-less replay honestly.
    words,
  });
  return { markdown: md, report, warnings };
}

/** A page needs OCR only when its image signal accompanies an unusable text
 * layer. The caller supplies the image part of that decision. */
function needsPageOcr(chars: number): boolean {
  return chars < AUTO_OCR_CHARS_PER_PAGE;
}

function textNotices(collected: CollectResult, ocrPages: Set<number>, warn: (message: string) => void): void {
  for (const page of collected.pages) {
    if (page.textChars !== 0 || ocrPages.has(page.page)) continue;
    if (page.hasImage) warn(`p${page.page}: no extractable text; page has image content and OCR was not selected`);
    else warn(`p${page.page}: no extractable text; the page may be blank or contain only vector content`);
  }
  for (const page of collected.pages) {
    if (!page.largeImage || ocrPages.has(page.page)) continue;
    warn(`p${page.page}: text layer used but page carries large image(s); if it has baked-in text this output won't have it — compare (don't blindly replace) against --pages ${page.page} --ocr, which can itself introduce errors`);
  }
}

function analysisWords(pages: AnalysisPage[]): OcrWordInput[] {
  return pages.flatMap((page) => page.words.map((word) => ({ page: page.page, text: word.text, ...word.box, confidence: word.confidence })));
}

interface AutoAnalysisResult {
  analysis: Analysis;
  markdown: string;
  warnings: string[];
}

/** Shared automatic route for the library's Markdown result and the CLI's
 * raw/plain-text formats. A page changes producer only when it has image
 * evidence and an unusable text layer, so a blank or vector-only page never
 * becomes speculative OCR input. */
export async function analyzePdfAuto(pdfPath: string, opts: PdfToMarkdownOptions = {}): Promise<AutoAnalysisResult> {
  validatePages(opts.pages);
  const { warnings, warn } = warnCollector(opts.onWarning);
  const range = opts.pages ? { first: opts.pages.first, last: opts.pages.last ?? opts.pages.first } : {};

  if (opts.ocr) {
    const { pages, words } = await buildOcrAnalysisPages({ pdfPath }, { ...opts, onWords: undefined }, warn);
    const markdown = renderPagesToMarkdown(pages, { forcePageMarkers: true, pageMarkers: true });
    const report = buildOcrReport({ md: markdown, words });
    const analysis: Analysis = { outputVersion: report.outputVersion, report, pages };
    opts.onWords?.(words);
    return { analysis, markdown, warnings };
  }

  const collected = await collect(pdfPath, range);
  const ocrPageNumbers = new Set(!opts.noOcr ? collected.pages.filter((page) => page.hasImage && needsPageOcr(page.textChars)).map((page) => page.page) : []);
  if (!ocrPageNumbers.size) {
    const text = buildTextAnalysis(collected, opts.pageMarkers ?? false);
    textNotices(collected, ocrPageNumbers, warn);
    opts.onWords?.(text.words);
    return { analysis: text.analysis, markdown: text.markdown, warnings };
  }

  const textPageNumbers = new Set(collected.pages.filter((page) => !ocrPageNumbers.has(page.page)).map((page) => page.page));
  const text = textPageNumbers.size ? buildTextAnalysis(selectCollectedPages(collected, textPageNumbers), true) : undefined;
  const textByPage = new Map(text?.analysis.pages.map((page) => [page.page, page]));
  const ocrByPage = new Map<number, AnalysisPage>();
  const ocrWords: OcrWordInput[] = [];
  const ocrRanges: Array<{ first: number; last: number }> = [];
  for (const page of collected.pages) {
    if (!ocrPageNumbers.has(page.page)) continue;
    warn(`p${page.page}: sparse text layer with image content; using OCR for this page`);
    const lastRange = ocrRanges.at(-1);
    if (lastRange && lastRange.last + 1 === page.page) lastRange.last = page.page;
    else ocrRanges.push({ first: page.page, last: page.page });
  }
  for (const range of ocrRanges) {
    const result = await buildOcrAnalysisPages({ pdfPath }, { ...opts, pages: range, onWords: undefined }, warn);
    for (const page of result.pages) ocrByPage.set(page.page, page);
    ocrWords.push(...result.words);
  }
  textNotices(collected, ocrPageNumbers, warn);
  const pages = collected.pages.map((page) => ocrByPage.get(page.page) ?? (textByPage.get(page.page) as AnalysisPage));
  const markdown = renderPagesToMarkdown(pages, { forcePageMarkers: true, pageMarkers: true });
  const pagePaths = new Map(pages.map((page) => [page.page, page.path]));
  const report = buildOcrReport({
    md: markdown,
    fallback: true,
    words: ocrWords,
    pagePaths,
    hybridPages: text?.analysis.report.hybridPages,
  });
  if (text) {
    report.bodyFontHeight = text.analysis.report.bodyFontHeight;
    report.headingSizes = text.analysis.report.headingSizes;
    report.listItems = text.analysis.report.listItems;
    report.joinedPairs = text.analysis.report.joinedPairs;
    report.closedHyphens = text.analysis.report.closedHyphens;
    report.hybridPages = text.analysis.report.hybridPages;
  }
  const analysis: Analysis = { outputVersion: report.outputVersion, report, pages };
  opts.onWords?.(analysisWords(pages));
  return { analysis, markdown, warnings };
}

/**
 * Extract each page from embedded text, using OCR only when the page has
 * image content and fewer than `AUTO_OCR_CHARS_PER_PAGE` text characters.
 *
 * @param pdfPath path to the PDF file
 * @param opts see {@link PdfToMarkdownOptions}
 */
export async function pdfToMarkdown(pdfPath: string, opts: PdfToMarkdownOptions = {}): Promise<ExtractResult> {
  const result = await analyzePdfAuto(pdfPath, opts);
  return { markdown: result.markdown, report: result.analysis.report, warnings: result.warnings };
}
