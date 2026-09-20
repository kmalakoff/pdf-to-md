// Shared text-layer analysis. It keeps PDF source runs separate from layout
// reconstruction, while Markdown blocks retain the source-run indexes that
// produced them.
import type { PageWord } from './geometry.ts';
import { toLines } from './lines.ts';
import { buildMarkdown } from './markdown.ts';
import { buildReport, OUTPUT_VERSION } from './report.ts';
import type { Analysis, AnalysisPage, AnalysisWord, CollectResult, Glyph, PageLines } from './types.ts';

function sourceWord(glyph: Glyph, dims: { width: number; height: number }): AnalysisWord {
  return {
    text: glyph.s,
    box: {
      x: dims.width > 0 ? glyph.bounds.x / dims.width : 0,
      y: dims.height > 0 ? (dims.height - glyph.bounds.y - glyph.bounds.h) / dims.height : 0,
      w: dims.width > 0 ? glyph.bounds.w / dims.width : 0,
      h: dims.height > 0 ? glyph.bounds.h / dims.height : 0,
    },
  };
}

function callbackWords(pages: AnalysisPage[]): PageWord[] {
  return pages.flatMap((page) => page.words.map((word) => ({ page: page.page, text: word.text, ...word.box })));
}

export interface TextAnalysisResult {
  analysis: Analysis;
  markdown: string;
  words: PageWord[];
}

export function selectCollectedPages(collected: CollectResult, pageNumbers: Set<number>): CollectResult {
  const pages = collected.pages.filter((page) => pageNumbers.has(page.page));
  const heightChars = new Map<number, number>();
  for (const page of pages) {
    for (const glyph of page.glyphs) heightChars.set(glyph.h, (heightChars.get(glyph.h) ?? 0) + glyph.s.length);
  }
  return { numPages: pages.length, pages, heightChars };
}

/** Builds the text result once for Markdown, raw analysis, text callbacks,
 * and reporting. The `pages` returned by buildMarkdown own the actual block
 * construction, so this never reconstructs ownership from rendered text. */
export function buildTextAnalysis(collected: CollectResult, pageMarkers: boolean): TextAnalysisResult {
  const pageLines: PageLines[] = collected.pages.map((page) => ({ page: page.page, lines: toLines(page) }));
  const rendered = buildMarkdown(pageLines, collected.heightChars, { pageMarkers });
  const statsMd = pageMarkers ? rendered.md : buildMarkdown(pageLines, collected.heightChars, { pageMarkers: true }).md;
  const hybridPages = collected.pages.filter((page) => page.largeImage).map((page) => page.page);
  const report = buildReport({
    numPages: collected.numPages,
    md: rendered.md,
    statsMd,
    stats: rendered.stats,
    bodyH: rendered.bodyH,
    headingSizes: rendered.headingSizes,
    hybridPages,
  });
  const analysisPages: AnalysisPage[] = collected.pages.map((page) => ({
    page: page.page,
    path: 'text',
    words: page.glyphs.map((glyph) => sourceWord(glyph, page)),
    blocks: rendered.pages.find((renderedPage) => renderedPage.page === page.page)?.blocks ?? [],
  }));
  const analysis: Analysis = { outputVersion: OUTPUT_VERSION, report, pages: analysisPages };
  return { analysis, markdown: rendered.md, words: callbackWords(analysisPages) };
}
