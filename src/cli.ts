// Parsing and dispatch only. Commands live in src/cli/, one file each,
// lazy-loaded — nothing tree- or dependency-heavy may be imported at the top of this file (`render` must never load the OCR engine, `--version` must load almost nothing).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from './cli/index.ts';
import type { Ctx } from './cli/types.ts';

// __dirname (CJS) or its ESM equivalent, then two fixed hops up to the
// package root. NOT `import.meta.resolve('pdf-to-md/package.json')` — Node's self-reference lookup throws ERR_MODULE_NOT_FOUND from a file this deep; a location-relative path is stable across both build targets.
const __dirname = path.dirname(typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url));
const ERROR_CODE = 19;

function packageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function usage(name: string): string {
  return (
    `usage: ${name} <file.pdf> [out.md] [flags...]        convert a PDF to markdown\n` +
    `       ${name} extract <file.pdf> [out.md] [flags...] (same, explicit)\n` +
    `       ${name} render <file.pdf> <page>[-<page>] [--dpi|-d N (default 288)] [--out|-o DIR (default .)]\n` +
    `       ${name} audit <words.jsonl> <file.md>          severity-1 word-loss check\n` +
    `       ${name} --version | --help\n` +
    '\n' +
    'extract flags:\n' +
    '  --ocr                force the OCR path (image-only/scanned pages)\n' +
    '  --no-ocr             never fall back to OCR; keep sparse text output\n' +
    '  --pages N[-M]        convert only these 1-based source pages\n' +
    '  --stdout             write markdown to stdout instead of a file\n' +
    '  --json               print the full QA report as JSON\n' +
    `  --page-markers       emit a "### pN" heading per page\n` +
    '  --format md|txt|raw  output format (default md; raw = Analysis JSON incl. the\n' +
    '                       report; txt = reading-order plain text)\n' +
    '  --words-json=FILE    OCR path from a recognized-word dump (offline replay)\n' +
    '  --debug-words=FILE   dump every recognized word as JSON lines to FILE\n' +
    '  --dpi=N              OCR render resolution (default 288; raise for tiny print or\n' +
    '                       chart/label pages, >~400 measured worse on ordinary prose)\n' +
    '\n' +
    `extract tuning (measured defaults; see README's tuning table):\n` +
    '  --float-max-words=N --float-max-width=F --float-margin=F --para-gap=F\n' +
    '  --heading-scale=F --col-max-width=F --col-split=F --line-y-tol=F\n' +
    '  --line-height-ratio=F\n' +
    '\n' +
    'examples:\n' +
    `  ${name} book.pdf                        # text layer -> book.md (auto-OCR if scanned)\n` +
    `  ${name} scan.pdf out.md --ocr --json    # force OCR, print the QA report\n` +
    `  ${name} book.pdf --pages 27-31 --stdout # re-extract a page range to stdout\n` +
    `  ${name} render book.pdf 27              # render p27 to PNG for eyeballing (288 dpi)\n` +
    `  ${name} audit words.jsonl book.md       # check no recognized word was lost`
  );
}

// All failures exit ERROR_CODE: usage errors with the usage text, thrown errors with the message verbatim.
export default async function cli(argv: string[], name: string): Promise<void> {
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(packageVersion());
    return;
  }
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    // No args is a usage ERROR (bare `pdf-to-md` can't do anything); asking
    // for --help is not.
    if (argv.length === 0) {
      console.error(usage(name));
      process.exit(ERROR_CODE);
    }
    console.log(`${name} v${packageVersion()}`);
    console.log('');
    console.log(usage(name));
    return;
  }

  const ctx: Ctx = {
    name,
    rest: argv.slice(1),
    usageError(message) {
      console.error(message);
      process.exit(ERROR_CODE);
    },
    errorCode: ERROR_CODE,
  };

  try {
    const load = COMMANDS[argv[0]];
    if (load) {
      await (await load()).default(ctx);
    } else {
      // Compat shim: `pdf-to-md file.pdf [...]` — any first word that isn't
      // a reserved command is extract's own first argument.
      ctx.rest = argv;
      await (await COMMANDS.extract()).default(ctx);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(ERROR_CODE);
  }
}
