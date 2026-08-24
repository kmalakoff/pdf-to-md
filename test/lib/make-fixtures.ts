#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
// make-fixtures.ts — deterministically draws the test suite's fixture PDFs.
//   node test/lib/make-fixtures.ts <outDir>

// Canvas text rendering (Skia) isn't byte-identical across renderers, so
// font sizes/spacing below are tuned for OCR fidelity where the fixture needs it — never a test assertion.
// The typeface itself is pinned (see canvasFont) so the glyphs, at least, are the same everywhere.

// pdf-lib assembles PDFs (pure TS); @napi-rs/canvas renders "ocr" fixtures'
// raster content — the same renderer src/raster.ts uses in production.
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from 'pdf-lib';

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;

// --- shared "place text, warn if it blows a column budget" abstraction ----

// `Surface` is the seam: a vector (pdf-lib) page and a raster (canvas)
// bitmap each implement measure/draw in their own coordinate system, so `place()` can warn at generation time instead of failing a column-detection test later.
interface Surface {
  measure(text: string, size: number, bold: boolean): number;
  draw(text: string, text_x: number, text_y: number, size: number, bold: boolean): void;
}

interface PlaceOpts {
  bold?: boolean;
  budget?: number;
  label?: string;
}

function place(surface: Surface, text: string, x: number, y: number, size: number, opts: PlaceOpts = {}): void {
  const { bold = false, budget, label = '' } = opts;
  if (budget !== undefined) {
    const w = surface.measure(text, size, bold);
    if (w > budget) {
      process.stderr.write(`warning: ${label} line exceeds column budget (${Math.round(w)}pt > ${Math.round(budget)}pt): ${text}\n`);
    }
  }
  surface.draw(text, x, y, size, bold);
}

// --- vector surface: real text layer via pdf-lib --------------------------

interface VectorSurface extends Surface {
  page: PDFPage;
}

function vectorSurface(page: PDFPage, regular: PDFFont, bold: PDFFont): VectorSurface {
  return {
    page,
    measure(text, size, isBold) {
      return (isBold ? bold : regular).widthOfTextAtSize(text, size);
    },
    draw(text, x, y, size, isBold) {
      page.drawText(text, {
        x,
        y,
        size,
        font: isBold ? bold : regular,
        color: rgb(0, 0, 0),
      });
    },
  };
}

// "text" fixtures draw real text via pdf-lib's font API straight onto the
// page — a genuine embedded text layer, exercising the default pdf.js path in src/collect.ts.
async function writeTextPDF(outPath: string, draw: (s: VectorSurface) => void): Promise<void> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  draw(vectorSurface(page, regular, bold));
  writeFileSync(outPath, await doc.save());
}

/** Two-page document: exercises --pages (Layer 3, see fixture 8's comment below). */
async function writeTextPDF2(outPath: string, draw1: (s: VectorSurface) => void, draw2: (s: VectorSurface) => void): Promise<void> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page1 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  draw1(vectorSurface(page1, regular, bold));
  const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  draw2(vectorSurface(page2, regular, bold));
  writeFileSync(outPath, await doc.save());
}

// --- raster surface: image-only page via @napi-rs/canvas ------------------

// Canvas is top-left, y-DOWN; PDF is bottom-left, y-UP. `toPx` converts each
// (x,y) pair per call rather than using a global negative-scale transform, which would mirror glyph shapes instead of just repositioning them.
function toPx(scale: number, pageHeightPt: number, xPt: number, yPt: number): { x: number; y: number } {
  return { x: xPt * scale, y: (pageHeightPt - yPt) * scale };
}

// The OCR assertions downstream are calibrated against these exact glyphs, so
// the bitmaps have to be the same on every machine. A system font stack cannot
// promise that: macOS resolves Helvetica, a CI Linux runner has neither
// Helvetica nor Arial and silently falls back to whatever it does have, and
// @napi-rs/canvas will not synthesise a bold Helvetica even where Helvetica
// exists. Draw with the Liberation Sans that pdfjs-dist (already a runtime
// dependency) ships instead: metric-compatible with Arial/Helvetica, and the
// same substitution pdf.js itself makes for them, so no binary joins the repo.
const fixtureFonts = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts');
for (const file of ['LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf']) {
  if (!GlobalFonts.registerFromPath(path.join(fixtureFonts, file))) throw new Error(`could not register fixture font ${file}`);
}

function canvasFont(sizePx: number, bold: boolean): string {
  return `${bold ? 'bold ' : ''}${sizePx}px "Liberation Sans"`;
}

interface RasterSurface extends Surface {
  ctx: SKRSContext2D;
  scale: number;
  pageHeight: number;
}

function rasterSurface(ctx: SKRSContext2D, scale: number, pageHeight: number): RasterSurface {
  return {
    ctx,
    scale,
    pageHeight,
    measure(text, size, bold) {
      ctx.font = canvasFont(size * scale, bold);
      return ctx.measureText(text).width / scale;
    },
    draw(text, xPt, yPt, size, bold) {
      const { x, y } = toPx(scale, pageHeight, xPt, yPt);
      ctx.fillStyle = 'black';
      ctx.textBaseline = 'alphabetic';
      ctx.font = canvasFont(size * scale, bold);
      ctx.fillText(text, x, y);
    },
  };
}

/**
 * "ocr" fixtures: render text into an offscreen canvas bitmap and embed it
 * as the page's only content (no text operators), so pdf.js's text read comes back empty and the CLI routes the page to OCR, same as a scan.
 */
async function writeImagePDF(outPath: string, draw: (s: RasterSurface) => void, scale = 2.0): Promise<void> {
  const w = Math.round(PAGE_WIDTH * scale);
  const h = Math.round(PAGE_HEIGHT * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  draw(rasterSurface(ctx, scale, PAGE_HEIGHT));
  const png = await canvas.encode('png');

  const doc = await PDFDocument.create();
  const img = await doc.embedPng(png);
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawImage(img, { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT });
  writeFileSync(outPath, await doc.save());
}

/**
 * Small raster "label" with baked-in words, returned as a PNG buffer to
 * embed; its pixel dimensions become the image's declared width/height, which is what hasLargeImage inspects.
 */
function makeLabelBitmap(w: number, h: number): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  const surface = rasterSurface(ctx, 1, h);
  const size = 22;
  const budget = w - 32;
  place(surface, 'STRATEGY', 16, h - 40, size, {
    bold: true,
    budget,
    label: 'badge-STRATEGY',
  });
  place(surface, 'SIGNATURE', 16, h - 90, size, {
    bold: true,
    budget,
    label: 'badge-SIGNATURE',
  });
  place(surface, 'PROFILE', 16, h - 140, size, {
    bold: true,
    budget,
    label: 'badge-PROFILE',
  });
  return canvas.toBuffer('image/png');
}

// MARK: - fixtures

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    process.stderr.write('usage: make-fixtures.ts <outDir>\n');
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  // fixture 1: text-single.pdf — real text layer, single column
  await writeTextPDF(path.join(outDir, 'text-single.pdf'), (s) => {
    const left = 72;
    const body = 12;
    const pitch = 17;
    let y = 720;

    place(s, 'Garden Notes', left, y, 28, { bold: true, label: 'heading' });
    y -= 40;

    place(s, 'The morning sun crossed the quiet garden slowly', left, y, body, {
      label: 'p1l1',
    });
    y -= pitch;
    place(s, 'while silver dew still rested on the grass.', left, y, body, {
      label: 'p1l2',
    });
    y -= pitch * 2;

    place(s, 'Every gardener needs a spark of creat-', left, y, body, {
      label: 'p2l1',
    });
    y -= pitch;
    place(s, 'ive energy to keep the borders alive.', left, y, body, {
      label: 'p2l2',
    });
    y -= pitch * 2;

    place(s, 'Visitors often stopped to admire the roses', left, y, body, {
      label: 'p3l1',
    });
    y -= pitch;
    place(s, 'before wandering further into the orchard.', left, y, body, {
      label: 'p3l2',
    });
    y -= pitch * 2;

    place(s, '• Water the roses every morning', left, y, body, {
      label: 'list1',
    });
    y -= pitch;
    place(s, '• Trim the hedges before summer', left, y, body, {
      label: 'list2',
    });
    y -= pitch;
    place(s, '• Rake fallen leaves in autumn', left, y, body, {
      label: 'list3',
    });
  });

  // fixture 2: text-twocol.pdf — real text layer, two columns, clean gutter
  await writeTextPDF(path.join(outDir, 'text-twocol.pdf'), (s) => {
    const body = 12;
    const pitch = 17;
    const leftX = 60;
    const leftBudget = 230;
    const rightX = 322;
    const rightBudget = 230;

    let y = 700;
    place(s, 'The old library sat quiet', leftX, y, body, {
      budget: leftBudget,
      label: 'L1a',
    });
    y -= pitch;
    place(s, 'beside the tall oak trees.', leftX, y, body, {
      budget: leftBudget,
      label: 'L1b',
    });
    y -= pitch * 2;
    place(s, 'Readers came in from the rain.', leftX, y, body, {
      budget: leftBudget,
      label: 'L2',
    });
    y -= pitch * 2;
    place(s, 'Volunteers held a weekend book sale.', leftX, y, body, {
      budget: leftBudget,
      label: 'L3',
    });

    y = 700;
    place(s, 'The harbor market opened early', rightX, y, body, {
      budget: rightBudget,
      label: 'R1a',
    });
    y -= pitch;
    place(s, 'beneath a pale morning sky.', rightX, y, body, {
      budget: rightBudget,
      label: 'R1b',
    });
    y -= pitch * 2;
    place(s, 'Sailors unloaded crates of fish.', rightX, y, body, {
      budget: rightBudget,
      label: 'R2',
    });
    y -= pitch * 2;
    place(s, 'Fishermen mended their tattered nets.', rightX, y, body, {
      budget: rightBudget,
      label: 'R3',
    });
  });

  // fixture 3: ocr-single.pdf — image-only, single column
  await writeImagePDF(path.join(outDir, 'ocr-single.pdf'), (s) => {
    const left = 60;
    const body = 20;
    const pitch = 28;
    let y = 700;

    place(s, 'Mountain Journal', left, y, 60, { bold: true, label: 'heading' });
    y -= 24;

    place(s, 'The wide valley stretched beneath', left, y, body, {
      label: 'p1l1',
    });
    y -= pitch;
    place(s, 'the morning clouds and pine trees.', left, y, body, {
      label: 'p1l2',
    });
    y -= pitch * 6.0;

    place(s, 'Every hiker needs a spark of creat-', left, y, body, {
      label: 'p2l1',
    });
    y -= pitch;
    place(s, 'ive energy before the steep climb.', left, y, body, {
      label: 'p2l2',
    });
    y -= pitch * 6.0;

    place(s, 'Distant birds circled slowly above', left, y, body, {
      label: 'p3l1',
    });
    y -= pitch;
    place(s, 'the camp as hikers packed their gear.', left, y, body, {
      label: 'p3l2',
    });
  });

  // fixture 4: ocr-twocol.pdf — image-only, two columns, one line near the gutter
  await writeImagePDF(path.join(outDir, 'ocr-twocol.pdf'), (s) => {
    const body = 20;
    const pitch = 28;
    const leftX = 40;
    const leftBudget = 250;
    const rightX = 322;
    const rightBudget = 250;

    let y = 680;
    place(s, 'Bread was sold near closing.', leftX, y, body, {
      budget: 260,
      label: 'L1a-near-gutter',
    });
    y -= pitch;
    place(s, 'Crowds filled the market.', leftX, y, body, {
      budget: leftBudget,
      label: 'L1b',
    });
    y -= pitch;
    place(s, 'Bakers closed the stalls.', leftX, y, body, {
      budget: leftBudget,
      label: 'L1c',
    });
    y -= pitch * 6.0;
    place(s, 'Vendors called out prices.', leftX, y, body, {
      budget: leftBudget,
      label: 'L2',
    });

    y = 680;
    place(s, 'Sailors docked before noon.', rightX, y, body, {
      budget: rightBudget,
      label: 'R1a',
    });
    y -= pitch;
    place(s, 'Gulls circled the harbor pier.', rightX, y, body, {
      budget: rightBudget,
      label: 'R1b',
    });
    y -= pitch;
    place(s, 'Fishermen sorted the catch.', rightX, y, body, {
      budget: rightBudget,
      label: 'R1c',
    });
    y -= pitch * 6.0;
    place(s, 'Nets dried along the dock.', rightX, y, body, {
      budget: rightBudget,
      label: 'R2',
    });
  });

  // fixture 5: ocr-badge.pdf — image-only body + a rotated decorative badge
  await writeImagePDF(path.join(outDir, 'ocr-badge.pdf'), (s) => {
    const left = 60;
    const body = 20;
    const pitch = 28;
    let y = 700;

    place(s, 'Trail Guide', left, y, 60, { bold: true, label: 'heading' });
    y -= 24;

    place(s, 'Campers followed the marked trail', left, y, body, {
      label: 'p1l1',
    });
    y -= pitch;
    place(s, 'past the old stone bridge today.', left, y, body, {
      label: 'p1l2',
    });
    y -= pitch * 6.0;

    place(s, 'Every group needs a spark of creat-', left, y, body, {
      label: 'p2l1',
    });
    y -= pitch;
    place(s, 'ive spirit for the final climb.', left, y, body, {
      label: 'p2l2',
    });
    y -= pitch * 6.0;

    place(s, 'Sunlight filtered through the pines', left, y, body, {
      label: 'p3l1',
    });
    y -= pitch;
    place(s, 'as the trail wound toward the summit.', left, y, body, {
      label: 'p3l2',
    });

    // Decorative badge, tilted 6°, tucked outside the body column — tests
    // float ROUTING (short/narrow/off-column -> "> [floats]"), not badge legibility.

    // 6° is the measured ceiling: near-horizontal-only OCR reads it fine;
    // higher angles returned noise glyphs instead of exercising the float heuristic.

    // Angle is negated: canvas's y-DOWN pixel space rotates opposite PDF's
    // y-UP space for the same signed angle. Badge is rotated by hand (not via `place`, which only translates).
    const { x: px, y: py } = toPx(s.scale, s.pageHeight, 480, 90);
    s.ctx.save();
    s.ctx.translate(px, py);
    s.ctx.rotate((-6 * Math.PI) / 180);
    s.ctx.fillStyle = 'black';
    s.ctx.textBaseline = 'alphabetic';
    s.ctx.font = canvasFont(8 * s.scale, false);
    s.ctx.fillText('SAMPLE BADGE TEXT', 0, 0);
    s.ctx.restore();
  });

  // fixture 6: ocr-centered.pdf — CENTERED paragraphs, short last lines.
  // KNOWN BUG (float heuristic): a short centered last line sits right of the measured column edge and gets pulled into "> [floats]". See centered.test.ts.
  await writeImagePDF(path.join(outDir, 'ocr-centered.pdf'), (s) => {
    const body = 20;
    const pitch = 28;
    function centered(text: string, y: number, size = body): void {
      const w = s.measure(text, size, false);
      s.draw(text, (PAGE_WIDTH - w) / 2, y, size, false);
    }

    let y = 700;
    centered('The quiet valley stretched for miles', y);
    y -= pitch;
    centered('at dusk.', y); // short last line (<0.15 page width)
    y -= pitch * 6.0;

    centered('Travelers rested beside the river', y);
    y -= pitch;
    centered('and rest.', y); // short last line (<0.15 page width)
  });

  // fixture 7: ocr-colbreak.pdf — two columns; a sentence continues across
  // the column break. KNOWN BUG: each column is emitted independently, so the sentence splits into two paragraphs at the boundary. See column-break.test.ts.
  await writeImagePDF(path.join(outDir, 'ocr-colbreak.pdf'), (s) => {
    const body = 17;
    const pitch = 24;
    const leftX = 36;
    const leftBudget = 165;
    const rightX = 400;
    const rightBudget = 200;

    // Heading keeps an apostrophe on purpose: regression guard that "OWNER'S"
    // survives OCR and src/lines.ts's curly-quote-to-ASCII folding without deleting it.
    place(s, "OWNER'S NOTES", leftX, 720, 56, {
      bold: true,
      budget: 540,
      label: 'heading',
    });

    // Left column: four lines whose last one ends MID-SENTENCE (no terminal
    // punctuation), continuing at the top of the right column.
    let y = 640;
    place(s, 'Readers filled the old', leftX, y, body, {
      budget: leftBudget,
      label: 'L1',
    });
    y -= pitch;
    place(s, 'library and read the', leftX, y, body, {
      budget: leftBudget,
      label: 'L2',
    });
    y -= pitch;
    place(s, 'shelves till closing', leftX, y, body, {
      budget: leftBudget,
      label: 'L3',
    });
    y -= pitch;
    place(s, 'time, and the quiet', leftX, y, body, {
      budget: leftBudget,
      label: 'L4-continues',
    });

    // Right column: the continuation, then a separate paragraph.
    y = 640;
    place(s, 'reading room stayed', rightX, y, body, {
      budget: rightBudget,
      label: 'R1-continuation',
    });
    y -= pitch;
    place(s, 'warm that evening.', rightX, y, body, {
      budget: rightBudget,
      label: 'R2',
    });
    y -= pitch * 6.0;
    place(s, 'Lamps glowed above', rightX, y, body, {
      budget: rightBudget,
      label: 'R3',
    });
    y -= pitch;
    place(s, 'the polished desks.', rightX, y, body, {
      budget: rightBudget,
      label: 'R4',
    });

    // Gutter fragment: isolated on its own baseline so it's not merged into
    // the column above. Wide enough (>0.15 page width = 91.8pt) to escape the float heuristic and land in body flow, where it damages the join.
    const fragSize = 68;
    const fragW = s.measure('1/3', fragSize, false);
    if (fragW < PAGE_WIDTH * 0.15) {
      process.stderr.write(`warning: gutter fragment is ${Math.round(fragW)}pt, under the 0.15-page-width float threshold; it will not reproduce the escape\n`);
    }
    s.draw('1/3', 207, 500, fragSize, false);
  });

  // fixture 8: text-twopage.pdf — TWO pages, exercises --pages; each page
  // carries a distinct sentence/heading so selecting page 2 is trivially distinguishable from page 1 or a renumbering bug. See pages.test.ts.
  await writeTextPDF2(
    path.join(outDir, 'text-twopage.pdf'),
    (s) => {
      place(s, 'Lighthouse Log', 72, 720, 24, {
        bold: true,
        label: 'p1-heading',
      });
      place(s, 'The first page holds a lighthouse standing over a cold northern sea.', 72, 680, 12, { label: 'p1-sentence' });
    },
    (s) => {
      place(s, 'Windmill Log', 72, 720, 24, {
        bold: true,
        label: 'p2-heading',
      });
      place(s, 'The second page describes a windmill turning above golden summer fields.', 72, 680, 12, { label: 'p2-sentence' });
    }
  );

  // fixture 9: text-hybrid.pdf — real text layer plus a large embedded
  // bitmap with its own baked-in words, invisible to the text-layer path. Exercises hybrid-page detection (src/collect.ts's hasLargeImage). See hybrid.test.ts.
  {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const s = vectorSurface(page, regular, bold);

    const left = 72;
    const body = 12;
    const pitch = 17;
    let y = 720;

    place(s, 'Field Report', left, y, 24, { bold: true, label: 'heading' });
    y -= 36;

    // Sentences total well over 80 chars, clearing collect.ts's hybrid-page "text layer genuinely used" threshold.
    place(s, 'The survey team documented soil samples across the northern ridge', left, y, body, { label: 's1' });
    y -= pitch;
    place(s, 'and recorded moisture levels at each marked station along the way.', left, y, body, { label: 's2' });
    y -= pitch * 2;

    place(s, 'A second crew mapped the drainage patterns near the old orchard', left, y, body, { label: 's3' });
    y -= pitch;
    place(s, 'and confirmed the boundary lines against the county survey records.', left, y, body, { label: 's4' });

    // The hybrid-page gap: an image with baked-in words the text layer never
    // sees, placed below the sentences to avoid visual collision. 260x220px clears collect.ts's >=200px large-image threshold.
    const labelPng = makeLabelBitmap(260, 220);
    const labelImg = await doc.embedPng(labelPng);
    page.drawImage(labelImg, { x: 340, y: 280, width: 220, height: 220 });

    writeFileSync(path.join(outDir, 'text-hybrid.pdf'), await doc.save());
  }

  // fixture 10: ocr-book.pdf — 3-page synthetic "two-column scanned book"
  // fixture, filling the corpus's same-named slot (no verifiable real one was found).
  {
    const doc = await PDFDocument.create();
    // Light gray background (not pure white): the "photographed paper" look real scans have.
    const BG = '#f4f2ee';
    // Measured 2026-08-16: a plain two-column repro (p1's content alone)
    // read cleanly at both 1.0° and 1.5° rotation, but applied to the full
    // fixture, 1.5° cost recognition on p2 (pull-quote split into two lines, a word displaced into floats) — so this fixture stays flat (0°).
    const SKEW_DEG = 0;

    async function addPage(draw: (s: RasterSurface) => void, scale = 2.0): Promise<void> {
      const w = Math.round(PAGE_WIDTH * scale);
      const h = Math.round(PAGE_HEIGHT * scale);
      const canvas = createCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate((SKEW_DEG * Math.PI) / 180);
      ctx.translate(-w / 2, -h / 2);
      draw(rasterSurface(ctx, scale, PAGE_HEIGHT));
      ctx.restore();
      const png = await canvas.encode('png');
      const img = await doc.embedPng(png);
      const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      page.drawImage(img, {
        x: 0,
        y: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
      });
    }

    // --- page 1: heading + two columns + cross-column join -----------------

    // A sentence runs out of lines at the bottom of the left column and
    // continues, lowercase, at the top of the right — the same join ocr-colbreak.pdf exercises (src/emit.ts's C1 fix), on a multi-page doc.
    await addPage((s) => {
      const body = 17;
      const pitch = 24;
      const leftX = 40;
      const leftBudget = 230;
      const rightX = 330;
      const rightBudget = 250;

      place(s, 'Field Journal', leftX, 700, 60, {
        bold: true,
        label: 'p1-heading',
      });

      // Left column: a self-contained paragraph (the "left before right"
      // probe), then a second paragraph that runs out of lines mid-sentence.
      let y = 676;
      place(s, 'The old baker sold', leftX, y, body, {
        budget: leftBudget,
        label: 'p1-L1',
      });
      y -= pitch;
      place(s, 'warm bread at dawn.', leftX, y, body, {
        budget: leftBudget,
        label: 'p1-L2',
      });
      y -= pitch * 2;
      place(s, 'Farmers met near the well', leftX, y, body, {
        budget: leftBudget,
        label: 'p1-L3',
      });
      y -= pitch;
      place(s, 'to trade fresh eggs and', leftX, y, body, {
        budget: leftBudget,
        label: 'p1-L4',
      });
      y -= pitch;
      place(s, 'milk while children ran and', leftX, y, body, {
        budget: leftBudget,
        label: 'p1-L5',
      });
      y -= pitch;
      place(s, 'laughed at the geese that', leftX, y, body, {
        budget: leftBudget,
        label: 'p1-L6-continues',
      });

      // Right column: the continuation (lowercase start), then a separate
      // paragraph (the "left before right" ordering probe's other half).
      y = 676;
      place(s, 'wandered near the old barn', rightX, y, body, {
        budget: rightBudget,
        label: 'p1-R1-continuation',
      });
      y -= pitch;
      place(s, 'before the sun rose today.', rightX, y, body, {
        budget: rightBudget,
        label: 'p1-R2',
      });
      y -= pitch * 2;
      place(s, 'Sailors packed the boxes', rightX, y, body, {
        budget: rightBudget,
        label: 'p1-R3',
      });
      y -= pitch;
      place(s, 'near the harbor at noon.', rightX, y, body, {
        budget: rightBudget,
        label: 'p1-R4',
      });
      y -= pitch * 2;
      place(s, 'Lanterns burned along the wall.', rightX, y, body, {
        budget: rightBudget,
        label: 'p1-R5',
      });
      y -= pitch;
      place(s, 'Fishermen counted the catch.', rightX, y, body, {
        budget: rightBudget,
        label: 'p1-R6',
      });
    });

    // --- page 2: two columns + centered pull-quote + page-number footer ---
    await addPage((s) => {
      const body = 17;
      const pitch = 24;
      const leftX = 40;
      const leftBudget = 230;
      const rightX = 330;
      const rightBudget = 250;

      // Pull-quote at heading height (page-local medianH * 2, tallGate) so
      // it groups as one full-width row instead of splitting at the gutter.
      const pullSize = 44;
      const pullText = 'STILL WATERS';
      const pullW = s.measure(pullText, pullSize, true);
      place(s, pullText, (PAGE_WIDTH - pullW) / 2, 712, pullSize, {
        bold: true,
        label: 'p2-pullquote',
      });

      let y = 660;
      place(s, 'Merchants sold spices at', leftX, y, body, {
        budget: leftBudget,
        label: 'p2-L1',
      });
      y -= pitch;
      place(s, 'the square each morning.', leftX, y, body, {
        budget: leftBudget,
        label: 'p2-L2',
      });
      y -= pitch * 2;
      place(s, 'Coopers built barrels from', leftX, y, body, {
        budget: leftBudget,
        label: 'p2-L3',
      });
      y -= pitch;
      place(s, 'the fresh cut oak wood.', leftX, y, body, {
        budget: leftBudget,
        label: 'p2-L4',
      });
      y -= pitch * 2;
      place(s, 'Weavers dyed the cloth', leftX, y, body, {
        budget: leftBudget,
        label: 'p2-L5',
      });
      y -= pitch;
      place(s, 'a deep and rich blue.', leftX, y, body, {
        budget: leftBudget,
        label: 'p2-L6',
      });

      y = 660;
      place(s, 'Miners carried coal up', rightX, y, body, {
        budget: rightBudget,
        label: 'p2-R1',
      });
      y -= pitch;
      place(s, 'from the deep dark pits.', rightX, y, body, {
        budget: rightBudget,
        label: 'p2-R2',
      });
      y -= pitch * 2;
      place(s, 'Smiths hammered iron beside', rightX, y, body, {
        budget: rightBudget,
        label: 'p2-R3',
      });
      y -= pitch;
      place(s, 'the glowing forge at dusk.', rightX, y, body, {
        budget: rightBudget,
        label: 'p2-R4',
      });
      y -= pitch * 2;
      place(s, 'Tanners cured the hides', rightX, y, body, {
        budget: rightBudget,
        label: 'p2-R5',
      });
      y -= pitch;
      place(s, 'down by the wide river.', rightX, y, body, {
        budget: rightBudget,
        label: 'p2-R6',
      });

      // Page-number decoration: body-scale height (never registers as a
      // heading) sitting well past paraGap * pitch below the last line (never paragraph-rescued into the column above).
      const pageNumSize = 14;
      const pageNumText = '2';
      const pageNumW = s.measure(pageNumText, pageNumSize, false);
      place(s, pageNumText, (PAGE_WIDTH - pageNumW) / 2, 45, pageNumSize, {
        label: 'p2-pagenum',
      });
    });

    // --- page 3: single WIDE column (two-column vote must not misfire) ----
    await addPage((s) => {
      const head = 56;
      const body = 20;
      const pitch = 28;
      const left = 60;
      const budget = 490;

      place(s, 'Open Road', left, 700, head, {
        bold: true,
        label: 'p3-heading',
      });

      // Every line crosses x=0.5 page width (shortest is 305pt wide from
      // x=60, right edge x=365 on a 612pt page, past the 306pt gutter split) — the gutter-ink signature that keeps the two-column vote from firing.
      let y = 660;
      place(s, 'The travelers walked the winding road', left, y, body, {
        budget,
        label: 'p3-L1',
      });
      y -= pitch;
      place(s, 'past quiet farms and golden wheat fields.', left, y, body, {
        budget,
        label: 'p3-L2',
      });
      y -= pitch * 6.0;
      place(s, 'Merchants set out early for the coast', left, y, body, {
        budget,
        label: 'p3-L3',
      });
      y -= pitch;
      place(s, 'while gulls circled the busy harbor.', left, y, body, {
        budget,
        label: 'p3-L4',
      });
      y -= pitch * 6.0;
      // Standalone wide line, no paragraph join — a contiguous regex match
      // against it tests that the two-column vote didn't band-split this row into out-of-order halves.
      place(s, 'The old wagon rolled across a wide stone bridge.', left, y, body, { budget, label: 'p3-wide-sentence' });
    });

    writeFileSync(path.join(outDir, 'ocr-book.pdf'), await doc.save());
  }

  // fixture 11: ocr-chart.pdf — models a real chart/infographic page (dense
  // numeral scatter, no prose structure): the case the review-marker feature exists for (src/emit.ts's REVIEW_REASON).
  await writeImagePDF(path.join(outDir, 'ocr-chart.pdf'), (s) => {
    place(s, 'Chart Summary', 60, 738, 40, {
      bold: true,
      label: 'heading',
    });

    // Label/value pairs: both sides carry 3+ letter words, so emitPage's
    // junk canary (`/[A-Za-z]{3}/`, same test the review marker uses) must not fire here.
    const labelSize = 20;
    const valueSize = 18;
    place(s, 'STRATEGY', 60, 668, labelSize, {
      bold: true,
      label: 'label-strategy',
    });
    place(s, 'To Respond', 60, 644, valueSize, { label: 'value-strategy' });
    place(s, 'AUTHORITY', 60, 610, labelSize, {
      bold: true,
      label: 'label-authority',
    });
    place(s, 'Sacral', 60, 586, valueSize, { label: 'value-authority' });

    // Scattered numerals around an implicit diagram — positive control: no
    // 3+ letter run anywhere, so it must land in a review-marked line, not an ordinary paragraph. No column alignment (only row order).

    // >=4 numerals/row keeps each row's word count above tuning.floatMaxWords
    // (3), so the scatter is body text, not floated decoration (geometry.ts's float pass).
    const numSize = 26;
    const rows: Array<{ y: number; xs: number[]; nums: string[] }> = [
      {
        y: 460,
        xs: [70, 165, 270, 375, 480],
        nums: ['1.3', '13.1', '47', '24.6', '56.6'],
      },
      {
        y: 428,
        xs: [95, 205, 305, 405, 505],
        nums: ['31.4', '20.5', '9.2', '44', '17.8'],
      },
      {
        y: 396,
        xs: [65, 185, 280, 395, 515],
        nums: ['2.3', '7.1', '19.2', '41.4', '33.2'],
      },
      {
        y: 364,
        xs: [105, 195, 315, 415, 495],
        nums: ['28', '5.6', '38.9', '12', '50.1'],
      },
    ];
    for (const row of rows) {
      row.nums.forEach((n, i) => {
        place(s, n, row.xs[i], row.y, numSize, { label: `gate-${row.y}-${i}` });
      });
    }

    // Ordinary prose paragraph — negative control: must appear as a normal
    // paragraph (no review marker, no floats).
    const body = 18;
    const pitch = 25;
    let y = 260;
    place(s, 'This chart summarizes how a person tends to make', 60, y, body, {
      label: 'prose-l1',
    });
    y -= pitch;
    place(s, 'decisions and interact with the people around them', 60, y, body, { label: 'prose-l2' });
    y -= pitch;
    place(s, 'over the course of an ordinary day.', 60, y, body, {
      label: 'prose-l3',
    });
  });

  // fixture 12: ocr-chart-only.pdf — numerals ONLY, the end-to-end trigger
  // for tesseract.ts's adaptive PSM.SPARSE_TEXT retry (SPARSE_RETRY_PROSE_FRACTION); fixture 11 triggers it too but ties on word count, never "sparse wins".

  // Denser/wider (8x5=40 numerals) so PSM.AUTO genuinely under-recognizes
  // while PSM.SPARSE_TEXT recovers all 40 — mirroring a real chart page's failure mode.
  // numSize is the knob that holds that gap open, and it is narrow: measured
  // against the pinned typeface (see canvasFont), 20-26pt lets AUTO read the whole
  // page on its own (no retry to observe, and at 26 it misreads 61 as 601), while
  // 14pt starves SPARSE_TEXT too. 18pt sits in the window at AUTO 38 -> SPARSE 40.
  await writeImagePDF(path.join(outDir, 'ocr-chart-only.pdf'), (s) => {
    const numSize = 18;
    const rows: Array<{ y: number; xs: number[]; nums: string[] }> = [
      {
        y: 700,
        xs: [70, 165, 270, 375, 480],
        nums: ['1.3', '13.1', '47', '24.6', '56.6'],
      },
      {
        y: 640,
        xs: [95, 205, 305, 405, 505],
        nums: ['31.4', '20.5', '9.2', '44', '17.8'],
      },
      {
        y: 580,
        xs: [65, 185, 280, 395, 515],
        nums: ['2.3', '7.1', '19.2', '41.4', '33.2'],
      },
      {
        y: 520,
        xs: [105, 195, 315, 415, 495],
        nums: ['28', '5.6', '38.9', '12', '50.1'],
      },
      {
        y: 460,
        xs: [80, 175, 290, 385, 490],
        nums: ['61', '3.9', '55.2', '46', '22.7'],
      },
      {
        y: 400,
        xs: [110, 210, 300, 410, 500],
        nums: ['15.4', '58', '27.1', '4.4', '36.6'],
      },
      {
        y: 340,
        xs: [75, 190, 285, 400, 505],
        nums: ['52', '11.3', '48.9', '6.2', '39.1'],
      },
      {
        y: 280,
        xs: [100, 200, 310, 420, 495],
        nums: ['1.6', '30', '17.2', '43.8', '59'],
      },
    ];
    for (const row of rows) {
      row.nums.forEach((n, i) => {
        place(s, n, row.xs[i], row.y, numSize, { label: `gate-${row.y}-${i}` });
      });
    }
  });

  process.stderr.write(`wrote 12 fixtures to ${outDir}\n`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
