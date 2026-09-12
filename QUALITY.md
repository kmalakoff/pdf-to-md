# Quality checks and tuning

`pdf-to-md` preserves recognized text and reports places where reconstruction may be wrong. This guide explains how to inspect a conversion and adjust OCR output. Start with the package [README](README.md) for installation and first use.

## Review a conversion

Run the conversion with its QA report:

```bash
npx pdf-to-md book.pdf --json
```

The report's `pageStats` identifies suspect pages. `report.danglingLong` flags likely reading-order failures. `report.reviewBlocks`, `report.floats` and low-confidence word samples identify output that needs inspection.

Render a suspect page and compare it with the Markdown:

```bash
npx pdf-to-md render book.pdf 12
npx pdf-to-md book.pdf page-12.md --pages 12 --ocr
```

The printed page is the ground truth. OCR can recover text baked into an image, but it can also introduce recognition errors. Compare the two paths on hybrid pages instead of assuming OCR is better.

## Audit recognized OCR words

`--debug-words` writes every OCR word as JSON lines. The `audit` command checks whether those words occur in the resulting Markdown:

```bash
npx pdf-to-md scan.pdf scan.md --ocr --debug-words=scan.words.jsonl
npx pdf-to-md audit scan.words.jsonl scan.md
```

An audit with `MISSING > 0` exits nonzero. The word dump is produced by OCR and OCR replay paths. Text-layer extraction does not produce it.

The audit detects missing recognized words. It cannot prove that OCR recognized the correct words or reconstructed their reading order correctly. Use the report and rendered pages for those checks.

## Visible review markers

The converter keeps uncertain text in regular markers:

```text
> [floats] ...
> [review: reason] ...
```

These markers let a person or downstream tool locate uncertain blocks. Removing them automatically can discard real sentence fragments, so the converter leaves that decision to the caller.

`report.closedHyphens` counts line-final words joined with a dictionary, such as `creat-` followed by `ive`. This can explain strict word-audit differences without indicating text loss.

## OCR controls

The OCR geometry defaults were measured against real documents. Change them for a document rather than editing source.

| Flag | Controls | Default |
|---|---|---:|
| `--float-max-words` | Maximum words in a decorative fragment | `3` |
| `--float-max-width` | Maximum fragment width as a page fraction | `0.15` |
| `--float-margin` | Required distance from the column edge | `0.008` |
| `--para-gap` | Vertical gap, as a multiple of line pitch, that starts a paragraph | `1.6` |
| `--heading-scale` | Line height, relative to body text, that starts a heading | `2.0` |
| `--col-max-width` | Maximum box width considered during gutter detection | `0.55` |
| `--col-split` | Fractional x-position of a two-column midpoint | `0.5` |
| `--line-y-tol` | Vertical tolerance for treating boxes as one line | `0.006` |
| `--line-height-ratio` | Maximum height ratio for boxes on one line | `2.4` |
| `--dpi` | OCR page-render resolution | `288` |

Raising `--dpi` may help tiny print and chart labels, but values above roughly 400 performed worse on ordinary prose in the project's tests. High DPI can also lose scattered numerals on a hybrid page. Compare results instead of treating a higher value as safer.

A typical correction loop is:

1. Convert with `--json`.
2. Inspect suspect pages in `pageStats`.
3. Render those pages.
4. Reconvert only those pages with `--pages` and an adjusted option.

Use `--format=raw` when you need the full analysis, including words, blocks and report, for a programmatic workflow.
