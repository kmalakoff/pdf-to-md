// analyze() plus the OCR-path core (buildOcrAnalysisPages) that extractOcr
// shares with it. Text analysis uses text-analysis.ts so it captures the same
// blocks, source runs, and report input as extractText.
import { collect, pageCount } from './collect.ts';
import { dictAvailable, dictUnavailableWarning } from './dict.ts';
import type { EmitBlock } from './emit.ts';
import { emitPage, renderEmitBlock } from './emit.ts';
import { recognizePdf } from './engines/tesseract.ts';
// Type-only: erased at compile time, so this does NOT create a runtime
// circular dependency even though src/extract.ts imports (value-level) from this module.
import type { ExtractOcrOptions, ExtractTextOptions, OcrWordInput } from './extract.ts';
import type { PageOCR, Tuning, Word } from './geometry.ts';
import { buildPageOCR, DEFAULT_TUNING, headingLevels } from './geometry.ts';
import { renderPagesToMarkdown } from './render-analysis.ts';
import { buildOcrReport, OUTPUT_VERSION } from './report.ts';
import { buildTextAnalysis } from './text-analysis.ts';
import type { Analysis, AnalysisBlock, AnalysisPage, AnalysisWord } from './types.ts';
import { validateOcrAnalysisInput, validatePages, validateWordsInput } from './validate.ts';

/** analyze(pdf) with the default/'text' path — OCR-only fields don't exist
 * on this branch, so passing e.g. `tuning` without `path: 'ocr'` is a compile error. */
export type AnalyzeTextOptions = ExtractTextOptions & { path?: 'text' };

/** analyze(pdf, {path:'ocr'}) — same fields as {@link ExtractOcrOptions},
 * unlocked only once `path: 'ocr'` is set. */
export type AnalyzeOcrOptions = ExtractOcrOptions & { path: 'ocr' };

/** Options for {@link analyze}: which fields type-check depends on `path`
 * (ignored, forced 'ocr', when `input` is a `{ words }` replay). */
export type AnalyzeOptions = AnalyzeTextOptions | AnalyzeOcrOptions;

function toAnalysisWord(w: OcrWordInput): AnalysisWord {
  const box = { x: w.x, y: w.y, w: w.w, h: w.h };
  return w.confidence === undefined ? { text: w.text, box } : { text: w.text, box, confidence: w.confidence };
}

// EmitBlock -> AnalysisBlock: collapses emit.ts's 'quote' kind (a pull-quote)
// into Analysis's 'paragraph' type, `text` keeping its literal '> ' prefix — see AnalysisBlock's doc comment (src/types.ts) for why.
function toAnalysisBlock(b: EmitBlock, wordIndex: Map<Word, number>): AnalysisBlock {
  const wordIndexes = b.words.map((w) => wordIndex.get(w) as number);
  if (b.kind === 'heading') return { type: 'heading', text: b.text, level: b.level, wordIndexes };
  if (b.kind === 'review') return { type: 'review', text: renderEmitBlock(b), wordIndexes };
  return { type: 'paragraph', text: renderEmitBlock(b), wordIndexes };
}

/** The OCR-path core shared by extractOcr and analyze(..., {path:'ocr'}):
 * recognizes (or replays) words and runs the unchanged buildPageOCR/emitPage pipeline. Word IDENTITY (object reference), not value, carries indices through into the emitted blocks — see `geometry.ts`'s OcrLine.words. */
export async function buildOcrAnalysisPages(input: { pdfPath: string } | { words: OcrWordInput[] }, opts: ExtractOcrOptions, warn: (m: string) => void): Promise<{ pages: AnalysisPage[]; words: OcrWordInput[] }> {
  const tuning: Tuning = { ...DEFAULT_TUNING, ...opts.tuning };
  const validated = validateOcrAnalysisInput(input);

  let words: OcrWordInput[];
  let first: number;
  let last: number;
  if ('words' in validated) {
    // Replay: page range from --pages if given, else every page up to the highest one the dump mentions.
    words = validated.words;
    first = opts.pages?.first ?? 1;
    last = opts.pages?.last ?? opts.pages?.first ?? Math.max(1, ...words.map((w) => w.page));
  } else {
    const totalPages = await pageCount(validated.pdfPath);
    const rawFirst = opts.pages?.first ?? 1;
    const rawLast = opts.pages?.last ?? (opts.pages ? rawFirst : totalPages);
    first = Math.min(Math.max(1, rawFirst), Math.max(1, totalPages));
    last = Math.min(Math.max(first, rawLast), totalPages);
    const result = await recognizePdf(validated.pdfPath, first, last, {
      dpi: opts.dpi,
      onProgress: opts.onProgress,
      onWarning: warn,
    });
    words = result.words;
  }

  words = words.filter((word) => word.page >= first && word.page <= last);
  opts.onWords?.(words);

  // Stable per-page index, assigned in recognition/replay order — this IS
  // the page's flat `words` list order; `wordIndex` recovers it later since geometry.ts never clones a Word (object identity survives row-building).
  const byPage = new Map<number, OcrWordInput[]>();
  const wordIndex = new Map<Word, number>();
  for (const w of words) {
    const list = byPage.get(w.page);
    if (list) {
      wordIndex.set(w, list.length);
      list.push(w);
    } else {
      wordIndex.set(w, 0);
      byPage.set(w.page, [w]);
    }
  }

  const pageOcrs = new Map<number, PageOCR>();
  for (let pn = first; pn <= last; pn++) pageOcrs.set(pn, buildPageOCR(byPage.get(pn) ?? [], tuning));
  const { levelOf } = headingLevels([...pageOcrs.values()], tuning);

  const pages: AnalysisPage[] = [];
  for (let pn = first; pn <= last; pn++) {
    const p = pageOcrs.get(pn) as PageOCR;
    // An in-range page with no recognized words stays visible (marker +
    // warning), never silently absent — same rule as extractOcr.
    if (!byPage.has(pn)) warn(`p${pn}: no recognized words, page emitted with no OCR text`);

    const blocks: AnalysisBlock[] = emitPage(p, levelOf, tuning).map((b) => toAnalysisBlock(b, wordIndex));
    // Decorative fragments always render as one visible "> [floats]" aside
    // per page (matching the one printed line) — see geometry.ts's PageOCR.floats.
    if (p.floats.length) {
      blocks.push({
        type: 'float',
        text: `> [floats] ${p.floats.map((f) => f.text).join(' · ')}`,
        wordIndexes: p.floats.flatMap((f) => f.words).map((w) => wordIndex.get(w) as number),
      });
    }

    pages.push({
      page: pn,
      path: 'ocr',
      words: (byPage.get(pn) ?? []).map(toAnalysisWord),
      blocks,
    });
  }

  return { pages, words };
}

async function analyzeOcr(input: { pdfPath: string } | { words: OcrWordInput[] }, opts: ExtractOcrOptions): Promise<Analysis> {
  const warn = (m: string) => opts.onWarning?.(m);
  if (!dictAvailable()) warn(dictUnavailableWarning());
  const { pages, words } = await buildOcrAnalysisPages(input, opts, warn);
  const md = renderPagesToMarkdown(pages, { forcePageMarkers: true, pageMarkers: true });
  const report = buildOcrReport({ md, fallback: opts.fallback, words });
  return { outputVersion: OUTPUT_VERSION, report, pages };
}

async function analyzeText(pdfPath: string, opts: ExtractTextOptions): Promise<Analysis> {
  const warn = (m: string) => opts.onWarning?.(m);
  if (!dictAvailable()) warn(dictUnavailableWarning());
  const range = opts.pages ? { first: opts.pages.first, last: opts.pages.last ?? opts.pages.first } : {};
  const collected = await collect(pdfPath, range);
  const result = buildTextAnalysis(collected, opts.pageMarkers ?? false);
  const hybridPages = collected.pages.filter((page) => page.largeImage).map((page) => page.page);
  for (const n of hybridPages) {
    warn(`p${n}: text layer used but page carries large image(s); if it has baked-in text this output won't have it — compare (don't blindly replace) against --pages ${n} --ocr, which can itself introduce errors`);
  }
  for (const page of collected.pages.filter((page) => page.textChars === 0 && !page.hasImage)) {
    warn(`p${page.page}: no extractable text; the page may be blank or contain only vector content`);
  }
  opts.onWords?.(result.words);
  return result.analysis;
}

/**
 * Analyze a PDF (or replay an already-recognized OCR word dump) into
 * `Analysis`: plain, JSON-serializable per-page `words`/`blocks` plus the same QA `report` the other entry points return. Render with toMarkdown()/toText(), or hand-edit/splice it (no merge API — see toMarkdown's doc comment).
 *
 * @param input a bare pdf path, or `{ words }` to replay a dump (always analyzed as OCR) — unlike extractOcr, never `{ pdfPath }`
 * @param opts see {@link AnalyzeOptions}; for a PDF path, `path` explicitly
 * selects text (default) or OCR. Automatic per-page routing belongs to
 * pdfToMarkdown and the CLI output formats.
 */
export async function analyze(input: string | { words: OcrWordInput[] }, opts: AnalyzeOptions = {}): Promise<Analysis> {
  validatePages(opts.pages);
  if (typeof input !== 'string') return analyzeOcr({ words: validateWordsInput(input) }, opts);
  if (opts.path === 'ocr') return analyzeOcr({ pdfPath: input }, opts);
  return analyzeText(input, opts);
}
