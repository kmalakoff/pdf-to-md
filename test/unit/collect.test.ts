import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import assert from 'assert';
import { safeRmSync } from 'fs-remove-compat';
import { degrees, PDFDocument, StandardFonts } from 'pdf-lib';
import { collect } from '../../src/collect.ts';
import { toLines } from '../../src/lines.ts';
import { scratchDir } from '../lib/tmp.ts';

interface TextRun {
  text: string;
  x: number;
  y: number;
  size?: number;
}

interface PdfOptions {
  name: string;
  origin?: { x: number; y: number };
  rotation?: number;
  text?: TextRun[];
  image?: boolean;
}

async function makePdf(directory: string, options: PdfOptions): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  if (options.origin) page.setMediaBox(options.origin.x, options.origin.y, 612, 792);
  if (options.rotation) page.setRotation(degrees(options.rotation));
  for (const run of options.text ?? []) {
    page.drawText(run.text, { x: run.x, y: run.y, size: run.size ?? 12, font });
  }
  if (options.image) {
    const canvas = createCanvas(2, 2);
    const context = canvas.getContext('2d');
    context.fillStyle = 'black';
    context.fillRect(0, 0, 2, 2);
    const image = await doc.embedPng(await canvas.encode('png'));
    page.drawImage(image, { x: 10, y: 10, width: 2, height: 2 });
  }
  const filePath = path.join(directory, options.name);
  writeFileSync(filePath, await doc.save());
  return filePath;
}

const closeTo = (actual: number, expected: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) < 0.1, `${message}: expected ${expected}, got ${actual}`);
};

describe('collect(): PDF text viewport geometry', () => {
  const directory = scratchDir('collect-geometry-');
  const simpleRun = [{ text: 'Coordinate baseline', x: 72, y: 700 }];

  after(() => safeRmSync(directory, { recursive: true, force: true }));

  it('keeps origin-zero baseline semantics and translates a nonzero page origin', async () => {
    const normalPath = await makePdf(directory, { name: 'origin-zero.pdf', text: simpleRun });
    const offsetPath = await makePdf(directory, {
      name: 'origin-offset.pdf',
      origin: { x: 24, y: 24 },
      text: simpleRun,
    });
    const [normal, offset] = await Promise.all([collect(normalPath), collect(offsetPath)]);
    const normalPage = normal.pages[0];
    const offsetPage = offset.pages[0];
    const normalGlyph = normalPage.glyphs[0];
    const offsetGlyph = offsetPage.glyphs[0];

    assert.equal(normalPage.width, 612);
    assert.equal(normalPage.height, 792);
    closeTo(normalGlyph.x, 72, 'origin-zero baseline x');
    closeTo(normalGlyph.y, 92, 'origin-zero baseline y');
    closeTo(normalGlyph.h, 12, 'origin-zero font height');
    assert.ok(normalGlyph.bounds.w > 0);
    assert.ok(normalGlyph.bounds.h > 0);

    closeTo(offsetPage.width, 612, 'offset viewport width');
    closeTo(offsetPage.height, 792, 'offset viewport height');
    closeTo(offsetGlyph.x, 48, 'offset baseline x');
    closeTo(offsetGlyph.y, 116, 'offset baseline y');
    closeTo(offsetGlyph.h, 12, 'offset font height');
    closeTo(offsetGlyph.bounds.x, 48, 'offset bounds x');
    assert.deepEqual(
      toLines(normalPage).map((line) => line.text),
      toLines(offsetPage).map((line) => line.text)
    );
  });

  it('rotates the baseline point and bounds while retaining the font-height magnitude', async () => {
    const rotatedPath = await makePdf(directory, {
      name: 'origin-offset-rotation-90.pdf',
      origin: { x: 24, y: 24 },
      rotation: 90,
      text: simpleRun,
    });
    const page = (await collect(rotatedPath)).pages[0];
    const glyph = page.glyphs[0];

    assert.equal(page.width, 792);
    assert.equal(page.height, 612);
    closeTo(glyph.x, 676, 'rotated baseline x');
    closeTo(glyph.y, 48, 'rotated baseline y');
    closeTo(glyph.h, 12, 'rotated font height');
    assert.ok(glyph.bounds.w > 0 && glyph.bounds.w < 20, `rotated bounds width should follow font height, got ${glyph.bounds.w}`);
    assert.ok(glyph.bounds.h > glyph.h, `rotated bounds height should follow text advance, got ${glyph.bounds.h}`);
  });

  it('keeps the offset two-column page in left-column then right-column reading order', async () => {
    const text: TextRun[] = [];
    for (let row = 0; row < 3; row++) {
      const y = 720 - row * 28;
      text.push({ text: `Right row ${row + 1}`, x: 340, y });
      text.push({ text: `Left row ${row + 1}`, x: 260, y });
    }
    const filePath = await makePdf(directory, {
      name: 'offset-two-column.pdf',
      origin: { x: 24, y: 24 },
      text,
    });
    const page = (await collect(filePath)).pages[0];
    const lines = toLines(page);
    const oldOriginLines = toLines({
      ...page,
      glyphs: page.glyphs.map((glyph) => ({ ...glyph, x: glyph.x + 24, y: glyph.y - 24 })),
    });
    const expected = ['Left row 1', 'Left row 2', 'Left row 3', 'Right row 1', 'Right row 2', 'Right row 3'];

    assert.deepEqual(
      lines.map((line) => line.text),
      expected
    );
    assert.notDeepEqual(
      oldOriginLines.map((line) => line.text),
      expected
    );
  });

  it('reports painted images independently of the text-gated large-image signal', async () => {
    const textPath = await makePdf(directory, { name: 'text-only.pdf', text: simpleRun });
    const imagePath = await makePdf(directory, { name: 'image-only.pdf', image: true });
    const [textPage, imagePage] = await Promise.all([collect(textPath), collect(imagePath)]);

    assert.equal(textPage.pages[0].hasImage, false);
    assert.equal(textPage.pages[0].largeImage, false);
    assert.equal(imagePage.pages[0].hasImage, true);
    assert.equal(imagePage.pages[0].largeImage, false);
  });
});
