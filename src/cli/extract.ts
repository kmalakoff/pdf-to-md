// extract command — parse this command's flags, call src/extract.ts, print
// and write the result. No business logic here — the library returns data and throws; only the CLI prints and exits.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { analyze } from '../analyze.ts';
import type { OcrWordInput } from '../extract.ts';
import { extractOcr, needsOcrFallback, ocrFallbackNotice, pdfToMarkdown } from '../extract.ts';
import type { Tuning } from '../geometry.ts';
import { toText } from '../render-analysis.ts';
import type { Analysis, Report } from '../types.ts';
import type { Command } from './types.ts';

const USAGE =
  'usage: pdf-to-md [extract] <file.pdf> [out.md] [--json] [--page-markers] [--ocr] [--no-ocr] ' +
  '[--pages N[-M]] [--stdout] [--words-json=FILE] [--debug-words=FILE] ' +
  '[--format md|txt|raw (default md; raw = Analysis JSON incl. the report; txt = reading-order plain text)] ' +
  '[--dpi=N (OCR render resolution, default 288; raise for tiny print or chart/label pages, ' +
  '>~400 measured worse on ordinary prose pages)] ' +
  '[--float-max-words=N] [--float-max-width=F] [--float-margin=F] [--para-gap=F] [--heading-scale=F] ' +
  '[--col-max-width=F] [--col-split=F] [--line-y-tol=F] [--line-height-ratio=F]';

const FORMATS = ['md', 'txt', 'raw'] as const;
type Format = (typeof FORMATS)[number];

// A bad tuning-flag value (non-numeric, or <= 0 unless the flag allows zero) is a usage error, not a silent no-op.
const TUNING_FLAGS: {
  name: string;
  key: keyof Tuning;
  allowZero?: boolean;
  isInt?: boolean;
}[] = [
  {
    name: 'float-max-words',
    key: 'floatMaxWords',
    allowZero: true,
    isInt: true,
  },
  { name: 'float-max-width', key: 'floatMaxWidth' },
  { name: 'float-margin', key: 'floatMargin' },
  { name: 'para-gap', key: 'paraGap' },
  { name: 'heading-scale', key: 'headingScale' },
  { name: 'col-max-width', key: 'colMaxWidth' },
  { name: 'col-split', key: 'colSplit' },
  { name: 'line-y-tol', key: 'lineYTol' },
  { name: 'line-height-ratio', key: 'lineHeightRatio' },
];

const extract: Command = async (ctx) => {
  // --debug-words takes a required FILE value; a bare --debug-words is a
  // usage error, checked before parseArgs so it can't silently swallow the next token as its value.
  if (ctx.rest.includes('--debug-words')) {
    ctx.usageError(`${USAGE}\n--debug-words requires a value: --debug-words=FILE`);
  }

  const parsed = (() => {
    try {
      return parseArgs({
        args: ctx.rest,
        options: {
          json: { type: 'boolean', default: false },
          'page-markers': { type: 'boolean', default: false },
          ocr: { type: 'boolean', default: false },
          'no-ocr': { type: 'boolean', default: false },
          stdout: { type: 'boolean', default: false },
          'debug-words': { type: 'string' },
          help: { type: 'boolean', default: false, short: 'h' },
          pages: { type: 'string' },
          dpi: { type: 'string' },
          format: { type: 'string', default: 'md' },
          'words-json': { type: 'string' },
          ...Object.fromEntries(TUNING_FLAGS.map((f) => [f.name, { type: 'string' as const }])),
        },
        allowPositionals: true,
      });
    } catch (err) {
      // usageError exits; the throw is dead code that tells the compiler so.
      throw ctx.usageError(`${(err as Error).message}\n${USAGE}`);
    }
  })();
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const positionals = parsed.positionals;

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const [src, outArg] = positionals;
  const wordsPath = values['words-json'] as string | undefined;
  if (!src && !wordsPath) ctx.usageError(USAGE);

  const formatRaw = values.format as string;
  if (!(FORMATS as readonly string[]).includes(formatRaw)) {
    ctx.usageError(`${USAGE}\n--format must be one of ${FORMATS.join('|')} (got ${JSON.stringify(formatRaw)})`);
  }
  const format = formatRaw as Format;

  // --pages: a malformed spec is a usage error; out-of-range page NUMBERS
  // clamp instead (collect.ts / the engine apply the same clamping policy).
  let pages: { first: number; last: number } | undefined;
  if (values.pages !== undefined) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(values.pages as string);
    const first = m ? Number(m[1]) : Number.NaN;
    const last = m ? (m[2] !== undefined ? Number(m[2]) : first) : Number.NaN;
    if (!m || first < 1 || last < first) {
      ctx.usageError(`${USAGE}\n--pages requires N or N-M, N >= 1, M >= N (got ${JSON.stringify(values.pages)})`);
    }
    pages = { first, last };
  }

  const tuning: Partial<Tuning> = {};
  for (const spec of TUNING_FLAGS) {
    const raw = values[spec.name] as string | undefined;
    if (raw === undefined) continue;
    const value = Number(raw);
    const ok = raw !== '' && Number.isFinite(value) && (spec.allowZero ? value >= 0 : value > 0);
    if (!ok) {
      ctx.usageError(`${USAGE}\n--${spec.name} requires a ${spec.allowZero ? 'non-negative' : 'positive'} number (got ${JSON.stringify(raw)})`);
    }
    (tuning[spec.key] as number) = spec.isInt ? Math.trunc(value) : value;
  }

  // --dpi: page-render resolution, validated like the tuning flags. Default
  // 288 is the measured operating point; >~400 measured WORSE on ordinary pages — not a "bigger is safer" knob.
  let dpi: number | undefined;
  if (values.dpi !== undefined) {
    const raw = values.dpi as string;
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || value <= 0) {
      ctx.usageError(`${USAGE}\n--dpi requires a positive number (got ${JSON.stringify(raw)})`);
    }
    dpi = value;
  }

  // In --words-json mode there may be no PDF positional; the words file
  // stands in for naming, extension stripped so the default dest can never overwrite the input. Default extension follows --format.
  const source = src ?? (wordsPath as string);
  const defaultExt = format === 'raw' ? 'json' : format === 'txt' ? 'txt' : 'md';
  const dest = outArg || `${source.replace(/\.(pdf|jsonl)$/i, '')}.${defaultExt}`;

  const onWarning = (m: string) => console.error(m);
  const showProgress = process.stderr.isTTY;
  // onProgress carries per-page timing/count only; human-readable
  // diagnostics (e.g. the sparse-retry notice) arrive via onWarning instead, so they print regardless of TTY-ness.
  const onProgress = (e: { type: 'page'; page: number; words: number; ms: number }) => {
    if (showProgress) console.error(`p${e.page}: ${e.words} words, ${e.ms}ms`);
  };
  const debugWordsPath = values['debug-words'] as string | undefined;
  if (debugWordsPath !== undefined && debugWordsPath.trim() === '') {
    ctx.usageError(`${USAGE}\n--debug-words requires a value: --debug-words=FILE`);
  }
  // The severity-1 audit instrument: every recognized word as clean JSON
  // lines to its own file. stderr stays a human channel (mixed prose), never a dump target — this file is guaranteed byte-for-byte parseable.
  const onWords = debugWordsPath
    ? (words: OcrWordInput[]) => {
        const lines = words.map((w) => {
          const entry: OcrWordInput = { page: w.page, text: w.text, x: w.x, y: w.y, w: w.w, h: w.h };
          if (w.confidence !== undefined) entry.confidence = w.confidence;
          return JSON.stringify(entry);
        });
        writeFileSync(debugWordsPath, lines.length ? `${lines.join('\n')}\n` : '');
      }
    : undefined;

  const common = { pages, onWarning };
  const ocrCommon = {
    ...common,
    tuning,
    dpi,
    onProgress,
    onWords,
  };

  let words: OcrWordInput[] | undefined;
  let skipped = 0;
  if (wordsPath !== undefined) {
    ({ words, skipped } = parseWordLines(readFileSync(wordsPath, 'utf8')));
    if (skipped > 0) console.error(`--words-json: skipped ${skipped} non-JSON line(s)`);
  }

  let content: string;
  let report: Report;
  if (format === 'md') {
    let markdown: string;
    if (words !== undefined) {
      ({ markdown, report } = await extractOcr({ words }, ocrCommon));
    } else {
      ({ markdown, report } = await pdfToMarkdown(src, {
        ...ocrCommon,
        ocr: values.ocr as boolean,
        noOcr: values['no-ocr'] as boolean,
        pageMarkers: values['page-markers'] as boolean,
      }));
    }
    content = markdown;
  } else {
    // raw/txt: both render from an Analysis — raw IS the Analysis as JSON;
    // txt is toText(analysis). Mirrors pdfToMarkdown's own auto-OCR fallback decision so a different --format doesn't silently pick a different path.
    let analysis: Analysis;
    if (words !== undefined) {
      analysis = await analyze({ words }, { ...ocrCommon, path: 'ocr' });
    } else if (values.ocr) {
      analysis = await analyze(src, { ...ocrCommon, path: 'ocr' });
    } else {
      const text = await analyze(src, { ...common, path: 'text', pageMarkers: values['page-markers'] as boolean });
      if (needsOcrFallback(text.report.charsPerPage) && !values['no-ocr']) {
        onWarning(ocrFallbackNotice(text.report.charsPerPage));
        analysis = await analyze(src, { ...ocrCommon, path: 'ocr', fallback: true });
      } else {
        analysis = text;
      }
    }
    report = analysis.report;
    content = format === 'raw' ? JSON.stringify(analysis, null, 1) : toText(analysis);
  }

  if (values.stdout) process.stdout.write(content);
  else writeFileSync(dest, content);

  // The library's Report stays clean of source/out; --json consumers keep
  // report.json files around and need to know which input produced each one, so the CLI (only) decorates the printed JSON with source/out here.
  if (values.json) console.log(JSON.stringify({ source, out: dest, ...report }, null, 1));
  else if (report.path === 'ocr') {
    console.error(`${path.basename(dest).padEnd(32)} OCR path heads=${report.headings}(junk ${report.junkHeadings}) ` + `paras=${report.paragraphs} callouts=${report.callouts} floats=${report.floats ?? 0} dangling=${report.danglingLong} (long) ` + `~${report.charsPerPage} chars/page`);
  } else {
    console.error(
      `${path.basename(dest).padEnd(32)} body=${report.bodyFontHeight}pt heads=${report.headings}(junk ${report.junkHeadings}) ` +
        `lists=${report.listItems} paras=${report.paragraphs} callouts=${report.callouts} pairs=${report.joinedPairs} ` +
        `~${report.charsPerPage} chars/page` +
        (report.sparse ? '  ⚠️  implausibly sparse — pages are likely images; re-run with --ocr' : '')
    );
  }
};

// Parse one word-dump JSON line per word — key order is not guaranteed, parse
// never grep. Non-JSON lines are skipped with a count, not fatal (the auditor applies the same policy).
function parseWordLines(raw: string): { words: OcrWordInput[]; skipped: number } {
  const words: OcrWordInput[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      words.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  return { words, skipped };
}

export default extract;
