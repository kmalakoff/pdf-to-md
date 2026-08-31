# real-replay fixtures

Real (not hand-built) OCR data used by `test/unit/real-replay.test.ts` as a coarser companion to `synthetic-replay.test.ts`'s exact-match gate: 100 pages of real Apple Vision OCR output, replayed through the current geometry/emission pipeline and checked against a diff-line bound rather than byte equality, because real OCR carries noise the hand-built synthetic fixture can't reproduce.

Provenance: Apple Vision OCR (`recognitionLevel = .accurate`, `usesLanguageCorrection = true`), captured 2026-08-16 against a personal 100-page image-only PDF, at commit `082981f` for word text and `17c0959` for geometry (the last commit with the Swift OCR backend, since deleted in favor of tesseract.js — see `plans/cross-platform-promise.md`). This data originally lived outside the repo in a local-only directory (`pdf-to-md-private/`) specifically because the extracted words were the real text of that personal document. Before being checked in here, every word's letters and digits were deterministically scrambled (same length, same case shape, same page/position — a pure function of the original run, so `vision-words.jsonl` and `vision-words-geo.jsonl` stay aligned line-for-line) so no readable content survives, while every property the geometry algorithm and regression check actually exercise — word count, per-word bounding boxes, confidences, page layout, line/paragraph boundaries — is untouched.

| file | what it is |
|---|---|
| `vision-words.jsonl` | `{page, text}` per recognized word — input to the shipped auditor (severity-1: nothing dropped) |
| `vision-words-geo.jsonl` | the same words WITH geometry — `{page, text, x, y, w, h}`, normalized page coordinates, origin bottom-left, y up — the input to the geometry replay |
| `vision-full.md` | the frozen markdown this data used to replay to, scrambled the same way; the diff-bound check in `real-replay.test.ts` compares against this |

One known side effect of scrambling: `emit.ts`'s dictionary-based hyphen rejoin no longer finds real English words at line-final hyphens, so the diff count against `vision-full.md` runs higher than it did pre-scramble (was 129 lines, now ~260, against a bound of 400) — that shift happened once, at scramble time, and isn't a signal of anything; treat the bound, not the absolute number, as what matters going forward.
