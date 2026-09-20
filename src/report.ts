// report.ts — QA report over an extraction, machine-readable with --json.
import { countPageMarkers, isPageMarkerLine, splitByPageMarker } from './page-marker.ts';
import type { BuildOcrReportInput, BuildReportInput, PageStatsRow, Report, WordConfidenceInput } from './types.ts';

// < SPARSE warns only; < AUTO_OCR means the pages are certainly images (measured:
// an image-only 100-pager yields ~4 chars/page) and the auto-OCR fallback fires.
export const SPARSE_CHARS_PER_PAGE = 200;
export const AUTO_OCR_CHARS_PER_PAGE = 20;

/** A manually-bumped integer, deliberately not the npm package version —
 * bump whenever a change can alter output for identical input. See `CHANGELOG.md` for history. */
export const OUTPUT_VERSION = 2;

// A body paragraph line may end in sentence/clause punctuation, a closing
// quote/bracket, an ellipsis, or a digit (chart/label lines like "1/3" legitimately end in a number).
const TERMINAL_PUNCT = /[.!?:;"”'’)\]…0-9]$/;

// Lines that are not body prose at all: headings (incl. "### pN" markers),
// floats/blockquotes, table rows, and list items — excluded before TERMINAL_PUNCT runs.
const NON_PROSE_LINE = /^[#>|*-]/;

// A `> [review: reason] text` line (src/emit.ts). Shared by pageStats (per
// page) and both top-level report builders (whole doc) so the counts can't drift apart.
const REVIEW_LINE = /^> \[review: /gm;

// Dangling lines split by length: long ones are the invisible column-break/splice
// signal; short ones are usually a missed heading or an unjoined label.
const DANGLING_LONG_MIN = 60;

/** Below this per-word confidence (0-100, tesseract.js's `confidence`), a
 * word counts as low-confidence. Measured: junk max 43 vs prose min 76, cut 60, 2026-08-17. */
export const LOW_CONFIDENCE_THRESHOLD = 60;

// Cap on `lowConfidenceSample`'s length per page — a few representative
// offenders, not the whole page re-emitted a second time.
export const LOW_CONFIDENCE_SAMPLE_CAP = 12;

interface LowConfidenceStats {
  measured: number; // words on this page that carried a confidence value at all
  low: number; // of those, how many scored below LOW_CONFIDENCE_THRESHOLD
  sample: string[]; // worst-confidence-first, capped list of the actual low-confidence tokens
}

// Grouped from the flat recognized-word list (confidence is per-word, never
// merged into a line — see Word's comment). `measured` is tracked separately from `low` so a page with nothing to measure reports ABSENT, not a lying zero.
function lowConfidenceByPage(words: WordConfidenceInput[]): Map<number, LowConfidenceStats> {
  const byPage = new Map<number, { measured: number; low: number; lowWords: { text: string; confidence: number }[] }>();
  for (const w of words) {
    if (w.confidence === undefined) continue;
    const entry = byPage.get(w.page) ?? { measured: 0, low: 0, lowWords: [] };
    entry.measured++;
    if (w.confidence < LOW_CONFIDENCE_THRESHOLD) {
      entry.low++;
      entry.lowWords.push({ text: w.text, confidence: w.confidence });
    }
    byPage.set(w.page, entry);
  }
  const result = new Map<number, LowConfidenceStats>();
  for (const [page, entry] of byPage) {
    // Sort ascending by confidence BEFORE capping, so the cap keeps the
    // worst offenders regardless of appearance order.
    const sample = entry.lowWords
      .slice()
      .sort((a, b) => a.confidence - b.confidence)
      .slice(0, LOW_CONFIDENCE_SAMPLE_CAP)
      .map((w) => w.text);
    result.set(page, { measured: entry.measured, low: entry.low, sample });
  }
  return result;
}

interface DanglingCounts {
  long: number;
  short: number;
}

// Counts of body paragraph LINES ending WITHOUT terminal punctuation, split
// by length: `long` is the invisible column-break/splice signal; `short` is usually a missed heading or unjoined label.
function danglingCounts(body: string): DanglingCounts {
  let long = 0;
  let short = 0;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || NON_PROSE_LINE.test(line)) continue;
    if (TERMINAL_PUNCT.test(line)) continue;
    if (line.length >= DANGLING_LONG_MIN) long++;
    else short++;
  }
  return { long, short };
}

// One page's own measured stats, derivable from its body text alone —
// shared by `pageStats` and any future caller that already has a page's body text in hand.
function measurePage(body: string): Omit<PageStatsRow, 'page' | 'path' | 'largeImages' | 'lowConfidenceWords' | 'lowConfidenceSample'> {
  const heads = body.match(/^#{1,6}\s*(.+)$/gm) || [];
  const dangling = danglingCounts(body);
  return {
    chars: body.length,
    headings: heads.length,
    junkHeadings: heads.filter((h) => !/[A-Za-z]{3}/.test(h)).length,
    floats: (body.match(/^> \[floats\]/gm) || []).length,
    paragraphs: (body.match(/^(?![#>-])\S.*$/gm) || []).length,
    danglingLong: dangling.long,
    danglingShort: dangling.short,
    reviewBlocks: (body.match(REVIEW_LINE) || []).length,
  };
}

// Per-page QA rows, one per "### pN" block. The text path always passes
// markdown with markers forced on (`statsMd`) regardless of `--page-markers`, so pageStats is always populated.
//
// `hybridPages` (text path only) marks a row `largeImages: true` when that
// page used its text layer but also carries a large embedded image; omitted entirely on the OCR path, which has no equivalent signal.
function pageStats(md: string, path: 'text' | 'ocr', hybridPages?: number[], pagePaths?: Map<number, 'text' | 'ocr'>): PageStatsRow[] {
  const rows: PageStatsRow[] = [];
  for (const { page, body } of splitByPageMarker(md)) {
    const row: PageStatsRow = { page, path: pagePaths?.get(page) ?? path, ...measurePage(body) };
    if (hybridPages && row.path === 'text') row.largeImages = hybridPages.includes(page);
    rows.push(row);
  }
  return rows;
}

export function buildReport({ numPages, md, statsMd, stats, bodyH, headingSizes, hybridPages = [] }: BuildReportInput): Report {
  const heads = (md.match(/^#{1,6}\s*(.+)$/gm) || []).filter((h) => !isPageMarkerLine(h)); // page markers are provenance, not structure
  const perPage = Math.round(md.length / numPages);
  const perPageStats = pageStats(statsMd, 'text', hybridPages);
  return {
    outputVersion: OUTPUT_VERSION,
    path: 'text',
    pages: numPages,
    bodyFontHeight: bodyH,
    headingSizes: headingSizes.slice(0, 6),
    chars: md.length,
    charsPerPage: perPage,
    sparse: perPage < SPARSE_CHARS_PER_PAGE,
    headings: heads.length,
    junkHeadings: heads.filter((h) => !/[A-Za-z]{3}/.test(h)).length,
    listItems: stats.listItems,
    paragraphs: stats.paragraphs,
    joinedPairs: stats.joinedPairs,
    callouts: stats.callouts,
    closedHyphens: stats.closedHyphens,
    danglingLong: perPageStats.reduce((sum, r) => sum + r.danglingLong, 0),
    danglingShort: perPageStats.reduce((sum, r) => sum + r.danglingShort, 0),
    reviewBlocks: perPageStats.reduce((sum, r) => sum + r.reviewBlocks, 0),
    // The text path never sees per-word confidence at all; 0 here means
    // "nothing to measure" (see PageStatsRow's field doc), not "measured 0".
    lowConfidenceWords: 0,
    hybridPages,
    pageStats: perPageStats,
  };
}

// QA report for the OCR path: measured from the emitted markdown text.
// `fallback` records that the text layer was tried first and found empty.
export function buildOcrReport({ md, fallback, words = [], pagePaths, hybridPages }: BuildOcrReportInput): Report {
  const numPages = countPageMarkers(md);
  const heads = (md.match(/^#{1,6}\s*(.+)$/gm) || []).filter((h) => !isPageMarkerLine(h));
  const perPage = numPages ? Math.round(md.length / numPages) : 0;
  const perPageStats = pageStats(md, 'ocr', hybridPages, pagePaths);
  // Attach the low-confidence detector's per-page results after the fact:
  // pageStats() has no confidence data (it reads markdown text only), so join it in here by page number.
  const lowConf = lowConfidenceByPage(words);
  for (const row of perPageStats) {
    const entry = lowConf.get(row.page);
    if (entry && entry.measured > 0) {
      row.lowConfidenceWords = entry.low;
      if (entry.sample.length) row.lowConfidenceSample = entry.sample;
    }
  }
  const mixed = pagePaths !== undefined && [...pagePaths.values()].some((path) => path === 'text');
  return {
    outputVersion: OUTPUT_VERSION,
    path: mixed ? 'mixed' : 'ocr',
    pages: numPages,
    ocrFallback: !!fallback,
    chars: md.length,
    charsPerPage: perPage,
    sparse: perPage < SPARSE_CHARS_PER_PAGE,
    headings: heads.length,
    junkHeadings: heads.filter((h) => !/[A-Za-z]{3}/.test(h)).length,
    paragraphs: (md.match(/^(?![#>-])\S.*$/gm) || []).length,
    // Exclude BOTH "[floats]" and "[review: ...]" lines — a review marker is
    // a labeled unstructured block, not a genuine callout.
    callouts: (md.match(/^> (?!\[floats\]|\[review:)/gm) || []).length,
    floats: (md.match(/^> \[floats\]/gm) || []).length,
    danglingLong: perPageStats.reduce((sum, r) => sum + r.danglingLong, 0),
    danglingShort: perPageStats.reduce((sum, r) => sum + r.danglingShort, 0),
    reviewBlocks: perPageStats.reduce((sum, r) => sum + r.reviewBlocks, 0),
    lowConfidenceWords: perPageStats.reduce((sum, r) => sum + (r.lowConfidenceWords ?? 0), 0),
    pageStats: perPageStats,
  };
}
