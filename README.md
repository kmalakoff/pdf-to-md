# @effortlessmotion/pdf-to-md

Convert born-digital and scanned PDFs to Markdown. `pdf-to-md` reads each page's text layer and uses local OCR where needed. It returns a QA report; the OCR path marks text it cannot place reliably for review.

Use it when you need editable Markdown plus evidence about conversion quality. OCR runs locally and makes no cloud calls.

## Requirements

- Node.js 22.13 or newer
- English text for the bundled OCR model. Text-layer extraction can preserve other languages.

## Install

```bash
npm install @effortlessmotion/pdf-to-md
```

## Convert a PDF

The package installs the `pdf-to-md` executable:

```bash
npx pdf-to-md book.pdf
```

This writes `book.md`. Pages with too little embedded text are assessed individually for OCR, so one document can use both extraction paths. The command reports those choices on stderr.

Specify an output path or force OCR when needed:

```bash
npx pdf-to-md scan.pdf notes.md --ocr
```

A conversion can produce ordinary Markdown plus visible review markers:

```text
## DAILY TALLIES

Every skiff was counted at the north pier.

> [review: unstructured labels] 12 47 380 5 91
```

The excerpt is illustrative. Review markers preserve text whose structure could not be recovered reliably.

## Library use

```js
import { pdfToMarkdown } from '@effortlessmotion/pdf-to-md';

const { markdown, report, warnings } = await pdfToMarkdown('book.pdf');

console.log(markdown);
console.log(report.path); // "text", "ocr", or "mixed"
console.warn(warnings);
```

`pdfToMarkdown()` uses the same text-first, automatic-OCR behavior as the CLI. It returns data and does not write files or exit the process. Conversion failures use `PdfToMdError` where the library assigns a package error code; native filesystem errors can also surface when inputs cannot be read.

Use `extractText()` or `extractOcr()` when you need to choose the path yourself. The [API documentation](https://kmalakoff.github.io/pdf-to-md/) lists the public functions, options and return types.

## Know which path ran

The QA report identifies the extraction path and highlights output that deserves review. Important cases:

- The bundled OCR model recognizes English. Use text-layer extraction for PDFs whose embedded text is in another language.
- A page can contain both embedded text and a large image with additional text. The text path warns about these hybrid pages so you can compare a targeted OCR pass.
- `> [floats]` and `> [review: ...]` blocks contain recognized text that the converter could not place confidently. They are intentionally visible.
- OCR quality depends on the scan. Check low-confidence words and rendered pages before relying on the result.

Use `--json` to print the report:

```bash
npx pdf-to-md book.pdf --json
```

See [quality checks and tuning](https://github.com/kmalakoff/pdf-to-md/blob/master/QUALITY.md) for the audit workflow, report fields and OCR controls.

## Common CLI options

```text
pdf-to-md <file.pdf> [out.md] [flags]
pdf-to-md render <file.pdf> <page>[-<page>]
pdf-to-md audit <words.jsonl> <file.md>
```

Common flags:

- `--ocr` forces OCR; `--no-ocr` disables automatic OCR fallback.
- `--pages N[-M]` converts a page range.
- `--stdout` writes the converted content to stdout.
- `--json` prints the QA report.
- `--format md|txt|raw` selects Markdown, plain text or analysis JSON.
- `--debug-words=FILE` writes source text items or recognized OCR words for `pdf-to-md audit`. Use `--page-markers` when producing Markdown for a page-by-page audit.
- `--dpi=N` changes OCR render resolution. The default is 288; higher values are not always more accurate.

Run `npx pdf-to-md --help` for the complete option list.

## Agent skill

An optional skill teaches compatible coding agents how to inspect the report, render suspect pages and run targeted conversions:

```bash
npx skills add kmalakoff/pdf-to-md
```

## Support and license

Report problems through the [GitHub issue tracker](https://github.com/kmalakoff/pdf-to-md/issues). See [CONTRIBUTING.md](https://github.com/kmalakoff/pdf-to-md/blob/master/CONTRIBUTING.md) to work on the package. The package is licensed under the [MIT License](https://github.com/kmalakoff/pdf-to-md/blob/master/LICENSE).
