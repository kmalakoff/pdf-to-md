// Pass 1: load each PDF text run into viewport points, plus the document-wide
// char-weighted font-height histogram. Height rounds to 0.1pt for stable histogram keys.
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { openDocument } from './pdf-open.ts';
import type { CollectedPage, CollectResult, Glyph } from './types.ts';

// HYBRID-PAGE DETECTION (README's "Design contract"): a page can carry a
// real text layer AND a separately-painted large image with its OWN baked-in text that `page.getTextContent()` never sees.
//
// Image presence uses the paint operators for XObjects, inline images, and masks.
// The large-image threshold uses `paintImageXObject` dimensions when available.
const LARGE_IMAGE_MIN_PX = 200;
interface PageImageSignals {
  hasImage: boolean;
  largeImage: boolean;
}

const IMAGE_PAINT_OPS = new Set([OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup, OPS.paintImageMaskXObjectRepeat, OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.paintInlineImageXObject, OPS.paintInlineImageXObjectGroup, OPS.paintSolidColorImageMask]);

async function getPageImageSignals(page: PDFPageProxy, textChars: number): Promise<PageImageSignals> {
  const { fnArray, argsArray } = await page.getOperatorList();
  let hasImage = false;
  let largeImage = false;
  for (let i = 0; i < fnArray.length; i++) {
    if (IMAGE_PAINT_OPS.has(fnArray[i])) hasImage = true;
    if (fnArray[i] !== OPS.paintImageXObject) continue;
    const [, w, h] = argsArray[i];
    if (typeof w === 'number' && typeof h === 'number') {
      if (w >= LARGE_IMAGE_MIN_PX && h >= LARGE_IMAGE_MIN_PX) largeImage = true;
    } else largeImage = true; // dims unavailable: coarser "op present" signal
  }
  return { hasImage, largeImage: textChars > 80 && largeImage };
}

// { first, last }: 1-based, inclusive page range (the CLI's --pages).
// Out-of-range values CLAMP to the document's bounds; `page` on each returned entry is always the SOURCE page number, so markers/splicing stay correct.
//
// CAVEAT: `heightChars` is built ONLY from the pages actually collected, so
// a `--pages` subset's heading levels can differ from a full run's — accepted since re-extracted pages get spliced back in for their prose, not diffed.

// Cheap page-count-only load (no per-page text extraction) — the OCR path
// needs it to resolve its own [first, last] clamping and print a "### pN" marker for every page in range, including ones with no recognized words.
export async function pageCount(src: string): Promise<number> {
  const doc = await openDocument(src);
  return doc.numPages;
}

export async function collect(src: string, { first, last }: { first?: number; last?: number } = {}): Promise<CollectResult> {
  const doc = await openDocument(src);
  const from = Math.min(Math.max(1, first ?? 1), Math.max(1, doc.numPages));
  const to = Math.min(Math.max(from, last ?? doc.numPages), doc.numPages);
  const pages: CollectedPage[] = [];
  const heightChars = new Map<number, number>();
  for (let p = from; p <= to; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    const vp = page.getViewport({ scale: 1 });
    const viewportScale = Math.hypot(vp.transform[0], vp.transform[1]);
    const glyphs: Glyph[] = [];
    let textChars = 0;
    for (const it of items) {
      if (!('str' in it) || typeof it.str !== 'string') continue;
      textChars += it.str.length;
      if (!it.str.trim()) continue;
      const transform = Util.transform(vp.transform, it.transform);
      const baselineLength = Math.hypot(transform[0], transform[1]);
      const w = Math.abs(it.width) * viewportScale;
      const h = Math.round(Math.hypot(transform[2], transform[3]) * 10) / 10;
      const baselineX = baselineLength > 0 ? (transform[0] / baselineLength) * w : w;
      const baselineY = baselineLength > 0 ? (transform[1] / baselineLength) * w : 0;
      const corners = [
        [transform[4], transform[5]],
        [transform[4] + baselineX, transform[5] + baselineY],
        [transform[4] + baselineX + transform[2], transform[5] + baselineY + transform[3]],
        [transform[4] + transform[2], transform[5] + transform[3]],
      ];
      const boundsX = corners.map(([x]) => x);
      const boundsY = corners.map(([, y]) => y);
      glyphs.push({
        s: it.str,
        x: transform[4],
        y: transform[5],
        w,
        h,
        bounds: {
          x: Math.min(...boundsX),
          y: Math.min(...boundsY),
          w: Math.max(...boundsX) - Math.min(...boundsX),
          h: Math.max(...boundsY) - Math.min(...boundsY),
        },
      });
      heightChars.set(h, (heightChars.get(h) || 0) + it.str.length);
    }
    // "text layer used" for hybrid-page purposes (page text > 80 chars) — a
    // page with only a couple of stray scraps isn't "using" the text layer even if it also carries a large image.
    const { hasImage, largeImage } = await getPageImageSignals(page, textChars);
    pages.push({
      page: p,
      glyphs,
      width: vp.width,
      height: vp.height,
      textChars,
      hasImage,
      largeImage,
    });
  }
  // `numPages` is the SELECTED count, not doc.numPages: the auto-OCR
  // chars/page floor must judge a `--pages` subset against its own page count, or a genuinely image-only page reads as merely "sparse".
  return { numPages: pages.length, pages, heightChars };
}
