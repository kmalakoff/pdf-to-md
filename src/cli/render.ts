// render command — render PDF pages to PNG for human/vision-model
// verification (extraction output is a claim; the page itself is the truth). Thin wrapper: parse flags, call src/raster.ts, write files.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PdfToMdError } from '../errors.ts';
import { awaitPdfOpen, openPdfForRender } from '../pdf-open.ts';
import { renderLoadedPage } from '../raster.ts';
import type { Command } from './types.ts';

const USAGE = 'usage: pdf-to-md render <file.pdf> <page>[-<page>] [--dpi|-d N (default 288)] [--out|-o DIR (default .)]';

const render: Command = async (ctx) => {
  const parsed = (() => {
    try {
      return parseArgs({
        args: ctx.rest,
        options: {
          dpi: { type: 'string', default: '288', short: 'd' },
          out: { type: 'string', short: 'o' },
          help: { type: 'boolean', default: false, short: 'h' },
        },
        allowPositionals: true,
      });
    } catch (err) {
      // usageError exits; the throw is dead code that tells the compiler so.
      throw ctx.usageError(`${(err as Error).message}\n${USAGE}`);
    }
  })();
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const [pdfPath, spec] = positionals;
  if (!pdfPath || !spec) ctx.usageError(USAGE);

  const m = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (m === null) throw ctx.usageError(`${USAGE}\ncould not parse page spec: ${spec}`);
  const firstPage = Number(m[1]);
  const lastPage = m[2] !== undefined ? Number(m[2]) : firstPage;
  if (!(firstPage >= 1) || !(lastPage >= firstPage)) throw ctx.usageError(`${USAGE}\ninvalid page spec: ${spec}`);

  const dpi = Number.parseFloat(values.dpi as string);
  if (!(dpi > 0)) ctx.usageError(`${USAGE}\n--dpi must be positive`);

  const outDir = values.out ?? process.cwd();
  mkdirSync(outDir, { recursive: true });
  const stem = path.basename(pdfPath, path.extname(pdfPath)).replaceAll(' ', '-');

  const loadingTask = openPdfForRender(pdfPath);
  try {
    const doc = await awaitPdfOpen(loadingTask, pdfPath);

    // Whole-range check before any file is written, so a partly-valid range
    // fails atomically; renderLoadedPage re-validates per page.
    if (lastPage > doc.numPages) {
      throw new PdfToMdError('PAGE_RANGE', `page range ${firstPage}-${lastPage} is outside this document (1-${doc.numPages})`);
    }
    for (let n = firstPage; n <= lastPage; n++) {
      const { png } = await renderLoadedPage(doc, n, dpi);
      const outPath = path.join(outDir, `${stem}-p${n}.png`);
      writeFileSync(outPath, png);
      console.log(outPath);
    }
  } finally {
    await loadingTask.destroy();
  }
};

export default render;
