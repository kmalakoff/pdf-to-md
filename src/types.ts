// Shared shapes threaded through the collect -> lines -> markdown -> report
// pipeline; kept in one place since every downstream stage uses at least one.

/** Viewport-point AABB for a source text run's transformed advance by
 * font-height box. This is a run box, not fabricated per-token geometry. */
export interface GlyphBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A positioned glyph run from the PDF's text layer: `s` may be more than one
// character. x/y are the transformed baseline origin in viewport points;
// w/h are its advance and font height, and bounds is their viewport AABB.
export interface Glyph {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
  bounds: GlyphBounds;
}

// One page's worth of collected glyphs plus the geometry collect.ts needs
// downstream (lines.ts's two-column detection, report.ts's hybrid-page flag).
export interface CollectedPage {
  page: number;
  glyphs: Glyph[];
  width: number;
  height: number;
  textChars: number;
  /** any painted image operator, independent of text-layer density */
  hasImage: boolean;
  largeImage: boolean;
}

// collect.ts's return value: selected pages plus the char-weighted
// font-height histogram, built ONLY from those pages (matters for a `--pages` re-extraction — see collect.ts).
export interface CollectResult {
  numPages: number;
  pages: CollectedPage[];
  heightChars: Map<number, number>;
}

// A visual line assembled from glyphs (lines.ts's `toLines`): `h` is the
// char-weighted dominant height (not max); `col` is 0 (left/only) or 1 (right, de-braided page).
export interface Line {
  text: string;
  x: number;
  y: number;
  h: number;
  col: number;
  /** indexes of the collected PDF text runs that produced this line, in
   * display order. OCR has its own source-word linkage. */
  wordIndexes: number[];
}

// One page's lines, as src/extract.ts assembles them for buildMarkdown.
export interface PageLines {
  page: number;
  lines: Line[];
}

export interface BuildMarkdownOptions {
  pageMarkers?: boolean;
}

// Running counters src/markdown.ts accumulates while building the output,
// surfaced in the QA report (src/report.ts's buildReport).
export interface MarkdownStats {
  headings: number;
  listItems: number;
  paragraphs: number;
  joinedPairs: number;
  reflowed: number;
  callouts: number;
  closedHyphens: number;
}

export interface MarkdownResult {
  md: string;
  stats: MarkdownStats;
  bodyH: number;
  headingSizes: number[];
  /** The structural blocks that produced `md`, grouped by source page.
   * Markers are rendering provenance and are deliberately not blocks. */
  pages: MarkdownPage[];
}

/** One row of the per-page QA breakdown ("### pN" blocks) — used to decide
 * which pages are worth rendering and re-checking (README's "Design contract"). */
export interface PageStatsRow {
  page: number;
  /** producer retained for this page, including in a mixed result */
  path: 'text' | 'ocr';
  chars: number;
  headings: number;
  junkHeadings: number;
  floats: number;
  paragraphs: number;
  danglingLong: number;
  danglingShort: number;
  /** count of `> [review: ...]` lines — blocks the geometry could not order
   * and labeled instead of guessing (README's "Design contract"). */
  reviewBlocks: number;
  /** present only on the text path's rows; omitted (not `false`) on the OCR
   * path, which has no per-page hybrid-image signal. */
  largeImages?: boolean;
  /** count of words below `report.ts`'s LOW_CONFIDENCE_THRESHOLD; omitted (not
   * 0) when the page had no confidence data at all, so "measured 0" and "nothing to measure" stay distinct. */
  lowConfidenceWords?: number;
  /** the suspect tokens behind `lowConfidenceWords`, worst-confidence first
   * and capped (`report.ts`'s LOW_CONFIDENCE_SAMPLE_CAP) so a chart-heavy page can't bloat the JSON. */
  lowConfidenceSample?: string[];
}

// buildReport's params (src/report.ts) — everything the text (default) path
// hands over after running collect -> lines -> markdown.
export interface BuildReportInput {
  numPages: number;
  md: string;
  /** identical to `md` but always carries "### pN" markers, so pageStats is
   * measured independent of the caller's `--page-markers` choice; same string as `md` when markers were requested. */
  statsMd: string;
  stats: MarkdownStats;
  bodyH: number;
  headingSizes: number[];
  hybridPages?: number[];
}

/** One recognized word's page/text/confidence — `report.ts`'s low-confidence
 * detector input; a structural subset of OcrWordInput kept here so `types.ts` doesn't import the library-layer module that depends on it. */
export interface WordConfidenceInput {
  page: number;
  text: string;
  confidence?: number;
}

export interface BuildOcrReportInput {
  md: string;
  fallback?: boolean;
  /** Per-page producer map for a mixed result. Omit for OCR-only output. */
  pagePaths?: Map<number, 'text' | 'ocr'>;
  /** text pages retaining a large embedded image, for mixed per-page QA */
  hybridPages?: number[];
  /** every recognized word, for `report.ts`'s low-confidence detector.
   * Defaults to [] (a pre-confidence --words-json replay), reporting the detector absent, never wrong. */
  words?: WordConfidenceInput[];
}

/** Per-document and per-page QA metrics returned by every extraction entry
 * point, discriminated by `path`; OCR-only and text-only fields are grouped below. */
export interface Report {
  /** manually-bumped integer (not the npm package version) — see
   * `report.ts`'s OUTPUT_VERSION for the bump rule; present on every Report so a frozen baseline's staleness is self-announcing. */
  outputVersion: number;
  path: 'text' | 'ocr' | 'mixed';
  pages: number;
  chars: number;
  charsPerPage: number;
  sparse: boolean;
  headings: number;
  junkHeadings: number;
  paragraphs: number;
  callouts: number;
  danglingLong: number;
  danglingShort: number;
  /** total `> [review: ...]` blocks across all pages (sum of pageStats'
   * reviewBlocks); always 0 on the text path — only the OCR path emits review markers. */
  reviewBlocks: number;
  /** document-level sum of pageStats' `lowConfidenceWords` — see that
   * field for why 0 can mean "measured 0" or "nothing to measure". */
  lowConfidenceWords: number;
  pageStats: PageStatsRow[];

  // --- OCR-only ---
  floats?: number;
  ocrFallback?: boolean;

  // --- text-only ---
  bodyFontHeight?: number;
  headingSizes?: number[];
  listItems?: number;
  joinedPairs?: number;
  closedHyphens?: number;
  hybridPages?: number[];
}

// --- Analysis: the raw-mode IR (analyze() produces it; toMarkdown()/toText()
// in render-analysis.ts render it — see toMarkdown's doc comment for the fail-fast validation contract) ---

/** One recognized/collected word, page-relative; `box` is always present.
 * See `AnalysisPage.words` for the coordinate contract and per-path granularity difference. */
export interface AnalysisWord {
  text: string;
  box: { x: number; y: number; w: number; h: number };
  confidence?: number;
}

/** One structural block; `wordIndexes` links it to its page's `words` list (blocks -> words only).
 * `text` is bare content for `'heading'` (level separate), else the LITERAL markdown line (decoration included, round-trippable) — a pull-quote is `'paragraph'`, not a 5th type. */
export interface AnalysisBlock {
  type: 'heading' | 'paragraph' | 'float' | 'review';
  text: string;
  /** Heading level (integer 1-6); REQUIRED when `type` is `'heading'`,
   * FORBIDDEN otherwise — toMarkdown()/toText() validate this fail-fast (throws PdfToMdError/'ANALYSIS_INPUT'), never silently ignored. */
  level?: number;
  /** adjacent Markdown line with no blank separator, used for list items */
  tight?: boolean;
  wordIndexes: number[];
}

/** One page's flat words plus its structural blocks. */
export interface AnalysisPage {
  page: number;
  /** producer retained for this page; `Analysis.report.path` is `'mixed'`
   * when the document has more than one page producer. */
  path: 'text' | 'ocr';
  /** Flat, page-relative source items; `AnalysisBlock.wordIndexes` indexes
   * into it. OCR boxes are normalized [0,1]. Text-run boxes are page
   * fractions and may extend outside that range when the PDF run extends past
   * the viewport. Both use a bottom-left origin with y up. */
  words: AnalysisWord[];
  blocks: AnalysisBlock[];
}

/** analyze()'s output: plain, JSON-serializable per-page words/blocks plus
 * the same QA `report` the other entry points return. */
export interface Analysis {
  /** manually-bumped integer — see `Report.outputVersion` / `report.ts`'s OUTPUT_VERSION. */
  outputVersion: number;
  /** the same QA report extractText/extractOcr/pdfToMarkdown return, always
   * measured off real markdown (OCR: the shared core's output; TEXT: buildMarkdown's reflowed output, not this coarser IR) — never stale relative to the IR. */
  report: Report;
  pages: AnalysisPage[];
}

/** One page's blocks from the text Markdown builder. This is internal
 * rendering evidence, but it is declared here because the shared text
 * analysis consumes it without parsing Markdown back into structure. */
export interface MarkdownPage {
  page: number;
  blocks: AnalysisBlock[];
}
