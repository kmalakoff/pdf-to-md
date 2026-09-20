// Pure renderers over the Analysis IR: toMarkdown()/toText() are the public,
// validated entry points; renderPagesToMarkdown/renderPagesToText below are the unvalidated core, reused (unvalidated) by src/analyze.ts.
import { PdfToMdError } from './errors.ts';
import { pageMarkerLine } from './page-marker.ts';
import type { Analysis, AnalysisBlock, AnalysisPage } from './types.ts';

const BLOCK_TYPES = new Set(['heading', 'paragraph', 'float', 'review']);

// Whole-object, fail-fast validation: every page/block/wordIndexes entry is
// checked BEFORE toMarkdown/toText render a single character — a malformed Analysis must never produce partial output, only a clean throw.
function validateAnalysis(analysis: unknown): asserts analysis is Analysis {
  const fail = (msg: string): never => {
    throw new PdfToMdError('ANALYSIS_INPUT', msg);
  };
  if (typeof analysis !== 'object' || analysis === null) fail('Analysis must be an object');
  const a = analysis as Record<string, unknown>;
  if (typeof a.report !== 'object' || a.report === null) fail('Analysis.report must be an object');
  const path = (a.report as Record<string, unknown>).path;
  if (path !== 'text' && path !== 'ocr' && path !== 'mixed') fail(`Analysis.report.path must be "text", "ocr", or "mixed" (got ${JSON.stringify(path)})`);
  if (!Array.isArray(a.pages)) fail('Analysis.pages must be an array');

  for (const [pi, page] of (a.pages as unknown[]).entries()) {
    if (typeof page !== 'object' || page === null) fail(`Analysis.pages[${pi}] must be an object`);
    const p = page as Record<string, unknown>;
    if (typeof p.page !== 'number') fail(`Analysis.pages[${pi}].page must be a number`);
    if (p.path !== 'text' && p.path !== 'ocr') fail(`Analysis.pages[${pi}].path must be "text" or "ocr" (got ${JSON.stringify(p.path)})`);
    if (!Array.isArray(p.words)) fail(`Analysis.pages[${pi}].words must be an array`);
    for (const [wi, w] of (p.words as unknown[]).entries()) {
      if (typeof w !== 'object' || w === null || typeof (w as Record<string, unknown>).text !== 'string') {
        fail(`Analysis.pages[${pi}].words[${wi}] must be an object with a string 'text'`);
      }
    }
    const wordCount = (p.words as unknown[]).length;

    if (!Array.isArray(p.blocks)) fail(`Analysis.pages[${pi}].blocks must be an array`);
    for (const [bi, b] of (p.blocks as unknown[]).entries()) {
      if (typeof b !== 'object' || b === null) fail(`Analysis.pages[${pi}].blocks[${bi}] must be an object`);
      const block = b as Record<string, unknown>;
      if (typeof block.type !== 'string' || !BLOCK_TYPES.has(block.type)) {
        fail(`Analysis.pages[${pi}].blocks[${bi}].type must be one of heading|paragraph|float|review (got ${JSON.stringify(block.type)})`);
      }
      if (typeof block.text !== 'string') fail(`Analysis.pages[${pi}].blocks[${bi}].text must be a string`);
      // `level` contract (see AnalysisBlock, src/types.ts): required 1-6 on a
      // heading, forbidden otherwise — rejected, not ignored, since it likely means `type` was mistyped.
      if (block.type === 'heading') {
        if (!Number.isInteger(block.level) || (block.level as number) < 1 || (block.level as number) > 6) {
          fail(`Analysis.pages[${pi}].blocks[${bi}].level must be an integer 1-6 on a heading block (got ${JSON.stringify(block.level)})`);
        }
      } else if (block.level !== undefined) {
        fail(`Analysis.pages[${pi}].blocks[${bi}].level is only allowed on heading blocks (got a ${JSON.stringify(block.type)} block with level ${JSON.stringify(block.level)})`);
      }
      if (block.tight !== undefined && typeof block.tight !== 'boolean') fail(`Analysis.pages[${pi}].blocks[${bi}].tight must be boolean when present`);
      if (!Array.isArray(block.wordIndexes)) fail(`Analysis.pages[${pi}].blocks[${bi}].wordIndexes must be an array`);
      for (const idx of block.wordIndexes as unknown[]) {
        if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= wordCount) {
          fail(`Analysis.pages[${pi}].blocks[${bi}].wordIndexes has an out-of-range index (${JSON.stringify(idx)}; page ${pi} has ${wordCount} words)`);
        }
      }
    }
  }
}

// See AnalysisBlock's doc comment (src/types.ts) for the `text` contract this relies on.
function renderBlockLiteral(block: AnalysisBlock): string {
  // A heading's `level` is guaranteed present (1-6): validateAnalysis
  // enforces it, and src/analyze.ts (the only unvalidated caller) always sets it.
  if (block.type === 'heading') return `${'#'.repeat(block.level as number)} ${block.text}`;
  return block.text;
}

/** Unvalidated core, reused by `src/analyze.ts`. `forcePageMarkers` is the
 * OCR path's always-on "### pN"; `pageMarkers` is the text path's opt-in flag, ignored when `forcePageMarkers` is set. */
export function renderPagesToMarkdown(pages: AnalysisPage[], opts: { forcePageMarkers: boolean; pageMarkers: boolean }): string {
  let md = '';
  for (const page of pages) {
    if (opts.forcePageMarkers) md += `\n${pageMarkerLine(page.page)}\n\n`;
    else if (opts.pageMarkers) md += `${pageMarkerLine(page.page)}\n\n`;
    for (const block of page.blocks) md += `${renderBlockLiteral(block)}${block.tight ? '\n' : '\n\n'}`;
  }
  return md;
}

// Strips a block's markdown decoration for plain-text rendering (the inverse
// of AnalysisBlock's literal-text convention); headings need no stripping.
function bareBlockText(block: AnalysisBlock): string {
  if (block.type === 'heading') return block.text;
  if (block.type === 'review') return block.text.replace(/^> \[review: [^\]]*\] /, '');
  if (block.type === 'float') return block.text.replace(/^> \[floats\] /, '');
  return block.text.replace(/^> /, '');
}

export function renderPagesToText(pages: AnalysisPage[]): string {
  const out: string[] = [];
  for (const page of pages) {
    for (const block of page.blocks) out.push(bareBlockText(block));
  }
  return out.length ? `${out.join('\n\n').trim()}\n` : '';
}

/**
 * Render an Analysis to markdown. PURE and fail-fast over any well-formed Analysis (including hand-built/spliced ones) — throws `PdfToMdError`/`'ANALYSIS_INPUT'` before any output on a malformed one.
 * OCR-origin output is byte-identical to extractOcr's own markdown. Text
 * output comes from the same captured blocks as extractText. Mixed output
 * always includes page markers because adjacent pages have different producers.
 *
 * @param analysis the Analysis to render (from analyze(), or hand-built/spliced)
 * @param opts.pageMarkers text-origin only; OCR and mixed Analysis values always carry markers
 */
export function toMarkdown(analysis: Analysis, opts: { pageMarkers?: boolean } = {}): string {
  validateAnalysis(analysis);
  const isOcr = analysis.report.path !== 'text';
  const md = renderPagesToMarkdown(analysis.pages, { forcePageMarkers: isOcr, pageMarkers: !!opts.pageMarkers });
  return isOcr ? md : `${md.trim()}\n`;
}

/**
 * Render an Analysis to reading-order plain text: headings drop their `#`;
 * float/review content is INCLUDED with only its markdown decoration stripped, so no content is lost silently. Same fail-fast validation as toMarkdown.
 *
 * @param analysis the Analysis to render (from analyze(), or hand-built/spliced)
 */
export function toText(analysis: Analysis): string {
  validateAnalysis(analysis);
  return renderPagesToText(analysis.pages);
}
