// render.test.ts — the `pdf-to-md render` subcommand, the human/vision-model verification step.
// Invoked as a subprocess (like test/lib/run.ts) since the CLI dispatches unconditionally at module load.

// Tests directly: exact PNG dimensions from page size + DPI with real ink (not a blank page), and
// the CLI's own arg validation (too few args / out-of-range page is a usage/range error, not a crash).

// No real-document check here — the render subcommand's job is handing a page to a human/vision
// model; the real-document smoke check is a manual `node bin/cli.js render` run (README's per-page workflow).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PdfToMdError } from '../../src/errors.ts';
import { renderPageToPNG } from '../../src/raster.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { scratchDir } from '../lib/tmp.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', '..', 'bin', 'cli.js');

/** Fraction of pixels in a PNG buffer that are NOT near-white. */
async function nonwhiteFraction(png: Buffer): Promise<number> {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);

  let nonwhite = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total++;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // "near-white" rather than exactly 255,255,255: antialiased glyph edges shade gradually
    // into the background, so only fully-white paper should NOT count as ink.
    if (r < 250 || g < 250 || b < 250) nonwhite++;
  }
  return nonwhite / total;
}

/** Run the CLI against one page of a fixture and return the written PNG's bytes. */
function renderFixturePage(fixtureName: string, page: number, dpi = 200): Buffer {
  const outDir = scratchDir('pdf-render-test-');
  const fixture = fixturePath(fixtureName);
  const result = spawnSync(process.execPath, [cliPath, 'render', fixture, String(page), '--dpi', String(dpi), '--out', outDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, `render failed: ${result.stderr}`);
  const stem = path.basename(fixture, path.extname(fixture));
  return readFileSync(path.join(outDir, `${stem}-p${page}.png`));
}

describe('render subcommand: text-single.pdf at 200 DPI', () => {
  it('renders the page at the expected pixel dimensions (US Letter, 612x792pt @ 200dpi)', async () => {
    const png = renderFixturePage('text-single.pdf', 1, 200);
    // scale = dpi / 72; 612 * 200/72 = 1700, 792 * 200/72 = 2200 exactly.
    const img = await loadImage(png);
    assert.equal(img.width, 1700);
    assert.equal(img.height, 2200);
    assert.ok(png.length > 0, 'expected a non-empty PNG buffer');
  });

  it('produces a page that is more than 1% non-white pixels (the fixture text actually rendered)', async () => {
    const png = renderFixturePage('text-single.pdf', 1, 200);
    const frac = await nonwhiteFraction(png);
    assert.ok(frac > 0.01, `expected > 1% non-white pixels, got ${(frac * 100).toFixed(2)}%`);
  });
});

describe('render subcommand: ocr-single.pdf (image-only fixture) at 200 DPI', () => {
  it('produces a page that is more than 1% non-white pixels', async () => {
    const png = renderFixturePage('ocr-single.pdf', 1, 200);
    const img = await loadImage(png);
    assert.equal(img.width, 1700);
    assert.equal(img.height, 2200);
    const frac = await nonwhiteFraction(png);
    assert.ok(frac > 0.01, `expected > 1% non-white pixels, got ${(frac * 100).toFixed(2)}%`);
  });
});

describe('renderPageToPNG: library error contract', () => {
  it('throws PdfToMdError code PDF_OPEN for a missing file', async () => {
    await assert.rejects(renderPageToPNG('/nonexistent/does-not-exist.pdf', 1, 200), (err: unknown) => err instanceof PdfToMdError && err.code === 'PDF_OPEN');
  });

  it('throws PdfToMdError code PAGE_RANGE for a page outside the document', async () => {
    await assert.rejects(renderPageToPNG(fixturePath('text-single.pdf'), 5, 200), (err: unknown) => err instanceof PdfToMdError && err.code === 'PAGE_RANGE');
  });
});

describe('render subcommand CLI: invalid args', () => {
  it('with no arguments, exits nonzero with a usage message on stderr', () => {
    const result = spawnSync(process.execPath, [cliPath, 'render'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: pdf-to-md render/);
  });

  it('with only a PDF path (missing page spec), exits nonzero with a usage message', () => {
    const result = spawnSync(process.execPath, [cliPath, 'render', fixturePath('text-single.pdf')], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage: pdf-to-md render/);
  });

  it('with a page spec outside the document, exits nonzero with a range error', () => {
    const result = spawnSync(process.execPath, [cliPath, 'render', fixturePath('text-single.pdf'), '5'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside this document/);
  });

  it('a partly-valid range fails atomically: no PNG written before the range error', () => {
    const outDir = scratchDir('render-range-');
    const result = spawnSync(process.execPath, [cliPath, 'render', fixturePath('text-single.pdf'), '1-5', '--out', outDir], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /outside this document/);
    assert.deepEqual(readdirSync(outDir), [], 'no page files should be written for an out-of-range range');
  });
});
