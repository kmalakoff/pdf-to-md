---
name: pdf-to-md
description: "Convert PDFs to Markdown with pdf-to-md, investigate missing or misordered text, and verify conversions against source pages and extraction evidence. Use for conversion, targeted re-extraction, or quality checks of pdf-to-md output."
---

# pdf-to-md

pdf-to-md reads embedded text and uses local OCR where needed. A preservation audit checks extracted text against Markdown. Recognition accuracy, reading order, tables and diagrams require comparison with rendered source pages.

## Convert with evidence

```sh
pdf-to-md file.pdf out.md --json --page-markers --debug-words=words.jsonl
```

Page markers connect the output to its source pages. `--debug-words` captures text-layer items or recognized OCR words before layout reconstruction. Text items can contain multiple words. Parse the dump as JSON Lines; key order is not fixed.

`--ocr` forces recognition and `--no-ocr` retains the text path. `--pages N[-M]` selects source pages. A mixed document can use different extraction paths per page. Keep the input identity, tool version, effective options, report and dump with the run's working artifacts so later corrections use matching evidence.

## Find pages to inspect

Read `report.pageStats` and warnings:

- `danglingLong` identifies prose that may have broken at the wrong place.
- `reviewBlocks` counts OCR blocks whose structure could not be recovered. The text path does not provide this detector; zero is not a layout guarantee.
- `lowConfidenceWords` and `lowConfidenceSample` identify uncertain OCR tokens. Missing confidence data is not a high-confidence result.
- `junkHeadings` identifies possible font-size classification errors.
- `largeImages` on text pages identifies images that may contain additional text. Compare a targeted OCR pass before replacing usable embedded text.

Also inspect sparse or empty pages and any layout the detectors do not cover. An unflagged page can still have incorrect columns, character mappings, tables or missing visual material.

## Compare against the page

```sh
pdf-to-md render file.pdf N
```

The default render is 288 DPI; use `--out DIR` for its destination. Compare the rendered page with the output, including item numbers, captions, symbols and reading order. Word presence alone does not validate these relationships.

For an OCR comparison or tuning experiment:

```sh
pdf-to-md file.pdf page-N.md --pages N --ocr --dpi 400 --debug-words=page-N.words.jsonl
```

OCR can recover image text and also damage correct embedded text. Higher DPI can improve small labels and worsen ordinary prose. Compare the result before accepting it. Read the package's `QUALITY.md` for tuning controls; their effects apply to OCR geometry.

If a page needs manual repair, retain its source dump and page number. An image can preserve a diagram visually but does not recover editable text. Record unresolved character mappings or flattened tables alongside the affected content.

## Audit the final Markdown

```sh
pdf-to-md audit words.jsonl out.md
```

A successful audit with `MISSING=0` means the supplied extracted text was accounted for under the auditor's matching rules. Empty or malformed evidence is an error. It does not prove that the dump captured every visible word or that the result is an accurate transcription.

The auditor accepts `### pN` headings and `<!-- pN -->` comments. Audit the final file after edits and marker changes. Use the matching extraction dump for any pages replaced with a different extraction. Keep editorial additions separate while checking preservation, because added text can satisfy a missing occurrence.

Report preservation results, visual/structural checks, and unresolved issues separately. Avoid a blanket "lossless" claim based on a word audit.

## Programmatic repair

`--format raw` returns an `Analysis` with per-page source items, blocks and a report. Text pages contain PDF text runs; OCR pages contain recognized words. Boxes use page-normalized coordinates, origin bottom-left, y increasing upward. Block `wordIndexes` link to the page's source list. Preserve that evidence when reordering blocks; rebuilding the source list from corrected output would make the audit circular.

OCR uncertainty markers remain visible in Markdown:

```text
> [floats] ...
> [review: reason] ...
```

Moving or deleting these blocks can remove real content. Check their source pages before changing them.

PDF compression is a separate operation. If requested, retain an identifiable original and verify text and visual material independently before replacing it. Lossy image compression can affect subsequent OCR and diagram checks even when extracted text stays identical.
