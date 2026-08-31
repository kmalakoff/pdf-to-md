# pdf-to-md

> Convert PDFs — born-digital or scanned — into markdown you can trust, under an explicit
> contract: recognized text is never silently lost, unrecoverable structure is marked rather
> than guessed, and every claim the output makes is mechanically checkable. When the defaults
> misread your document, you get the measured knobs, the detectors that point at exactly what to
> distrust, and the raw analysis to converge on a lossless conversion yourself.

Pure TypeScript, runs anywhere `npm install` works. No system dependencies, no cloud calls: the OCR engine ([tesseract.js](https://www.npmjs.com/package/tesseract.js)) and its recognition model install with the package and run fully offline.

```bash
npm install pdf-to-md
```

Requires Node >=22.13.0 — below that, the OCR path silently finds no words instead of erroring (see Development for the measured reason).

## CLI

```bash
npx pdf-to-md book.pdf                 # text layer -> book.md (auto-OCR if pages are images)
npx pdf-to-md scan.pdf out.md --ocr    # force the OCR path
```

```
pdf-to-md <file.pdf> [out.md] [flags...]         convert (implicit `extract`)
pdf-to-md render <file.pdf> <page>[-<page>]      render a page to PNG for eyeballing
pdf-to-md audit <words.jsonl> <file.md>          severity-1 check: every recognized word present?
pdf-to-md --help | --version
```

Everyday flags: `--ocr`, `--no-ocr`, `--pages N[-M]`, `--stdout`, `--json` (QA report), `--format md|txt|raw` (default `md`; `raw` = the full `Analysis` as JSON, report included; `txt` = reading-order plain text — line-granular on the text path with no paragraph reflow, block-granular on the OCR path), `--debug-words=FILE` (severity-1 audit input, see below), `--dpi=N` (OCR render resolution). Usage errors, runtime errors, and audit loss all exit non-zero.

## Library

```ts
import { pdfToMarkdown } from 'pdf-to-md';

const { markdown, report, warnings } = await pdfToMarkdown('book.pdf');
```

`pdfToMarkdown` is the headline API: text layer first, falling back to OCR on its own when the pages are images of text. For explicit control over which path runs (hybrid pages — a real text layer plus a large embedded image — are a class the tool itself flags, and reading both requires naming the path), the engine-agnostic word-input seam, and the `analyze`/`toMarkdown`/`toText` raw-analysis API described below, every exported function and option is documented at its declaration — `extractText`, `extractOcr`, `analyze`, `toMarkdown`, `toText`, `auditWords`, `DEFAULT_TUNING`, and the rest — visible in editor hover and in the [API Docs](https://kmalakoff.github.io/pdf-to-md/). TSDoc is the source of truth for per-option prose; this file stays a map, not a mirror.

All library functions throw a typed `PdfToMdError` (`code: 'PDF_OPEN' | 'PAGE_RANGE' | 'PAGE_RENDER' | 'OCR_PAGE_FAILED' | 'WORDS_INPUT' | 'ANALYSIS_INPUT'`) and never write to stdout/stderr or exit the process; warnings are returned data (plus an `onWarning` callback for streaming them).

## Design contract

What this tool promises about errors, in severity order — each with the instrument that enforces it:

1. **Silent text loss is forbidden.** Every word the engine recognizes lands in the output — body,
   heading, or a visible `> [floats]` aside. **Enforced by:** `--debug-words=FILE` dumps every
   recognized word as clean JSON lines (`{page, text, x, y, w, h, confidence?}`); the shipped
   `auditWords()` (or `pdf-to-md audit words.jsonl out.md`) checks the dump against the markdown
   and exits non-zero on any loss (`MISSING > 0`) — a first-class part of the product, usable as a CI
   gate, not a path into the source tree.
2. **Invisible corruption is minimized and made detectable.** Right-words-wrong-order failures
   (column braiding, mid-sentence splits) are what the geometry works hardest to prevent; a second
   class — right order, WRONG VALUE (an OCR misread spliced into otherwise word-like prose) — is
   what confidence scoring catches. **Enforced by:** `report.danglingLong` (the order-failure
   detector no output-only check can prove), `report.reviewBlocks` (blocks the geometry couldn't
   order, labeled rather than guessed at), and `report.lowConfidenceWords` /
   `pageStats[].lowConfidenceSample` (words the engine itself scored below confidence 60 — see
   `LOW_CONFIDENCE_THRESHOLD`'s test in `test/unit/review-blocks.test.ts` for the measured derivation).
3. **Visible misplacement is acceptable.** A fragment in the floats aside, a `> [review: ...]`
   block, or an odd paragraph break is something a caller can see and edit; the two classes above
   are not. **Enforced by:** the `> [floats]` / `> [review: reason]` markers themselves — regular
   enough (`^> \[(floats|review: [^\]]+)\] (.*)$`) for a downstream agent to find and handle
   without guessing — surfaced in `--json` as `report.floats` / `report.reviewBlocks`.

The QA report (`--json`) exists to make 2 and 3 reviewable: per-page stats flag suspect pages, and `pdf-to-md render` shows you the page as printed — the only real ground truth.

**Why there's no `--floats=drop`:** an earlier version offered one, filtering `> [floats]` lines out of the output. Measured against a real 100-page document, floats held real sentence tails on pages 29, 48, and 94 — "drop" invited exactly the silent loss rule 1 forbids, so the knob was cut. Filtering them back out downstream is one line (`^> \[floats\]`) a caller can write when floats truly are noise for their document; the tool won't make that call for you.

**`closedHyphens` as a cross-check, not a target:** the text path's `report.closedHyphens` counts line-final hyphens closed against a dictionary (e.g. "creat-" + "ive" → "creative"). It exists to explain the auditor's `strict_deficits` count, not to be optimized directly: a strict deficit is usually a hyphen-rejoin firing (a word split across two lines, correctly closed into one), not lost text — `MISSING` is the loss signal, and `closedHyphens` is what explains the difference.

## Tuning

OCR-path heuristics run on constants measured against real documents — the derivation for each lives beside its value in `src/geometry.ts`'s `DEFAULT_TUNING` (the canonical source; typedoc renders it). Override per run instead of editing source:

| flag | controls | default |
|---|---|---|
| `--float-max-words` | fragments with more words than this are body text, not decoration | `3` |
| `--float-max-width` | fraction of page width above which a fragment is too wide to be decoration | `0.15` |
| `--float-margin` | how far a fragment's left edge must sit from its column edge to be decoration | `0.008` |
| `--para-gap` | a vertical gap this many times the line pitch is a paragraph break | `1.6` |
| `--heading-scale` | lines taller than this times body height are headings | `2.0` |
| `--col-max-width` | boxes wider than this are excluded from gutter detection | `0.55` |
| `--col-split` | fractional x of the two-column midpoint | `0.5` |
| `--line-y-tol` | vertical distance within which two boxes are the same line | `0.006` |
| `--line-height-ratio` | same-line boxes with a larger height ratio don't merge | `2.4` |
| `--dpi` | OCR page-render resolution; raise for tiny print or chart/label pages, `>~400` measured worse on ordinary prose pages (`test/unit/sparse-retry.test.ts`) | `288` |

**Hybrid pages:** raising `--dpi` fixes chart/label corruption but can make scattered numerals on the same page WORSE, not better (measured: a chart page's numerals recognized at `288` dpi, then none at `600`, while the page's own text layer already had them all) — `--dpi` is a chart-LABEL fix, not a scattered-numeral fix. For hybrid pages, compare (or merge, via `analyze()`) the text-layer and OCR readings rather than trusting one dpi setting to fix everything on the page.

Typical loop: run with `--json`, find suspect pages in `pageStats`, `pdf-to-md render` them, then re-extract just those pages with `--pages` and an adjusted flag — or use `--format=raw` to get the full `Analysis` (words + blocks + report) and converge programmatically.

## For AI agents

```bash
npx skills add kmalakoff/pdf-to-md   # -g for global, -a claude-code to target
```

One skill: `pdf-to-md` for driving the QA loop above (reading `pageStats`, rendering pages as ground truth, targeted re-extraction, the severity-1 audit, and the `> [floats]` / `> [review: ...]` markers) instead of trusting the first conversion.

## Development

```bash
npm run build     # tsds build -> dist/cjs + dist/esm (pretest step; plain `npm test` builds first)
npm test          # synthetic fixtures (ground truth by construction), a fetched+sha256-pinned
                   # public corpus (skips offline), real engine runs, plus self-skipping
                   # private-document extras when available locally
npm run prepublishOnly   # tsds validate: build + biome + depcheck + docs
```

Source is TypeScript; the published package ships a built `dist/` (dual CJS + ESM via `tsds build`) because Node's native type-stripping refuses to run `.ts` files once they're under `node_modules`. Tests still run directly against source; the CLI test helper spawns the built `bin/cli.js`, which is why a build has to happen first.

`engines.node` is `>=22.13.0`, measured (not assumed): `pdfjs-dist`'s CJS build needs Node's stable synchronous `require(esm)`, and its rendering path uses a V8 `ArrayBuffer` API missing before Node 22. Don't lower this floor without re-running that measurement.
