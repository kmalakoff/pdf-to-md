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

## Audit extracted text

`--debug-words` writes text-layer items and recognized OCR words as JSON lines. Text-layer items can contain several words; their boxes describe the source items. The `audit` command checks normalized text occurrences on their source pages:

```bash
npx pdf-to-md book.pdf book.md --page-markers --debug-words=book.words.jsonl
npx pdf-to-md audit book.words.jsonl book.md
```

An audit with `MISSING > 0` exits nonzero. Invalid or empty evidence is an error, not a passing audit. Keep the dump from the same conversion and page selection as the Markdown. The auditor recognizes visible `### pN` and invisible `<!-- pN -->` page markers. Markerless Markdown needs page provenance before it can be audited.

The audit detects missing extracted text under its normalization and hyphen-repair rules. It cannot prove that OCR recognized the correct words, that the PDF's character mappings are accurate, or that reading order, tables and diagrams survived. Added editorial text can also satisfy a missing occurrence, so keep additions separate while auditing. Compare rendered pages for those checks and rerun the audit against the final file after edits.

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

Use `--format=raw` when you need the full analysis, including source items, blocks and report, for a programmatic workflow. Text pages retain PDF text runs with measured boxes; OCR pages retain recognized words. Block `wordIndexes` refer to these per-page source lists. Coordinates are normalized to the page, with the origin at the bottom left and y increasing upward. The raw source list is evidence captured before layout reconstruction, not text recovered from the rendered Markdown.
