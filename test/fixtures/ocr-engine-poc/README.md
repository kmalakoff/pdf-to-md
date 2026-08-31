# POC evidence: Node OCR engine benchmark (2026-08-16)

The measurements behind an OCR-engine decision that was made and then reversed the next day (scribe.js-ocr selected, then dropped in favor of tesseract.js over its AGPL-3.0 license and worker-crash behavior once both were benchmarked at matched settings; @gutenye/ocr-node rejected for line-level-only boxes + two-column mid-sentence merging). The full decision log is kept in this repo's untracked local planning notes, not published; this directory is the raw supporting evidence, kept for audit rather than because anything still reads it programmatically.

This directory originally lived outside the repo (`pdf-to-md-private/poc-ocr/`) because its input pages came from a personal document. Before being checked in here, every OCR-recognized word's letters/digits were deterministically scrambled (same length, same case shape — see `../real-replay/README.md` for the method) so no readable content survives; geometry, confidences, and overlap metrics are untouched. The two "disagreement crop" PNGs that used to live under `out/` were visual page crops (pixels, not scrubbable text) and were dropped rather than scrubbed — the quantitative evidence they illustrated is unaffected, in `out/analysis.json`.

- `run-{gutenye,scribe,scribe-one,tesseract}.mjs` — per-engine runners (each was `npm install`ed
  in an isolated dir; `package.json` records the versions measured)
- The Vision-baseline runner (`vision-image-ocr.swift`) was deleted with the rest of the Swift
  code (owner order, 2026-08-16) — recover it from git history at commit `17c0959` if a Vision
  re-comparison is ever needed; its word dumps are kept in `vision/` below
- `out/` — per-engine word JSON per page, `analysis.json` (overlap metrics)
- `vision/` — Vision word dumps for the benchmark pages

Input pages: 10, 27, 57 of the same document behind `test/fixtures/real-replay/`, rendered at 288 dpi via `bin/pdf-render.ts`, plus fixture `ocr-single.pdf`. Renders themselves not kept (22 MB, regenerable with one command). Key result table lives in `cross-platform-promise.md`.
