// corpus.ts — fetch-once cache for the public test corpus: entries are built
// once per key, staged in `<dest>.building`, and renamed atomically on success; every download is sha256-verified against a pinned hash before the rename.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TMP_ROOT } from './tmp.ts';

// Stable key, not a per-run unique dir: entries are fetched once and deliberately
// reused across runs, so the cache must survive between test invocations.
export const CACHE_DIR = path.join(TMP_ROOT, 'corpus');

export interface CorpusEntry {
  /** Cache filename, also the lookup key passed to corpusPath(). */
  name: string;
  url: string;
  /** Lowercase hex sha256 of the exact bytes at `url`, computed from a direct download (not copied from a listing). */
  sha256: string;
  /** Expected download size in bytes, recorded for provenance/debugging (not enforced beyond the sha256 check). */
  bytes: number;
  license: string;
  /** What the document is and why it's in the corpus. */
  what: string;
}

// usgs-fs20183035.pdf (below) was chosen for the corpus's CHART/INFOGRAPHIC
// slot: no genuinely two-column scanned PDF proved downloadable under an open license, but this one's chart page reproduces the tool's worst known OCR defect class instead.
export const CORPUS: CorpusEntry[] = [
  {
    name: 'layoutparser.pdf',
    url: 'https://arxiv.org/pdf/2103.15348',
    sha256: '467dd159f063cf01dc30d6f18bb7108534242f608d329d075a10f2507a025112',
    bytes: 4686220,
    license: 'CC-BY-4.0 — explicit license badge on the arXiv abstract page (https://arxiv.org/abs/2103.15348), linking to creativecommons.org/licenses/by/4.0/',
    what: "LayoutParser: A Unified Toolkit for Deep Learning Based Document Image Analysis (arXiv:2103.15348) — a real, born-digital, text-layer academic PDF, 16 pages. Measured through this repo's text path 2026-08-16: 16 pages, 42,702 chars (2,669 chars/page), 1 heading, 0 junkHeadings, 125 paragraphs, 0 dangling lines; 5 of 16 pages also carry large images (figures) and warn on the text path as designed (hybrid-page detection), which is expected, not a defect.",
  },
  {
    name: 'c02-22.pdf',
    url: 'https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/v16.10.0/tests/resources/c02-22.pdf',
    sha256: 'ae6a3bec3809e1540911bda42dabb42ffbd63cfda17e74a5c3e9dcd87129462a',
    bytes: 185098,
    // Pinned to the immutable v16.10.0 tag, not `main` (which 404'd after
    // upstream reorganized 2026-08-18); the swap kept the same sha256 and byte count.
    license:
      "CC-BY-SA-4.0 — SPDX header on OCRmyPDF's tests/resources/README.rst (SPDX-FileCopyrightText: 2022 James R. Barlow; SPDX-License-Identifier: CC-BY-SA-4.0) covers the resources directory; that README's own provenance table additionally credits the underlying scan to Project Gutenberg's \"Adventures of Huckleberry Finn\"",
    what: 'A single scanned page (novel page 22) of "Adventures of Huckleberry Finn", image-only (no text layer) — OCRmyPDF\'s own "difficult OCR image (obscure fonts and illustrations)" fixture. Measured through this repo\'s OCR path 2026-08-16: auto-falls back from the (near-empty) text path, 1 page, ~6s wall, 304 words recognized, 1,504 chars, 3 headings (0 junk), 16 paragraphs, 1 float (illustration noise); every recognized word lands in the markdown (0 missing under the no-silent-loss normalization).',
  },
  {
    name: 'usgs-fs20183035.pdf',
    url: 'https://pubs.usgs.gov/fs/2018/3035/fs20183035.pdf',
    sha256: 'cfe9df1d257365210a4e54b07b3044f56edc7493af2d173e4b2e389d33a0927c',
    bytes: 105821,
    // Not a tag URL: USGS has no versioned mirror, but this permanent
    // accession-number path is unchanged since 2018-06-15. The DOI (recorded for citation) redirects to an HTML landing page, not the PDF bytes.
    license:
      'U.S. Government work, public domain — USGS\'s copyright policy page (usgs.gov/information-policies-and-instructions/copyrights-and-credits) states "USGS-authored or produced data and information are considered to be in the U.S. Public Domain"; this fact sheet\'s publication landing page (pubs.usgs.gov/publication/fs20183035) attributes sole authorship to a USGS scientist ("Maupin, M.A., 2018 ... U.S. Geological Survey Fact Sheet 2018-3035") with no third-party-copyrighted content noted.',
    what: 'USGS Fact Sheet 2018-3035, "Summary of Estimated Water Use in the United States in 2015" (Maupin, 2018; DOI 10.3133/fs20183035) — a real, born-digital, 2-page infographic report: page 1 is a label/value icon chart ("Public supply 39.0", "Aquaculture 7.55", "Irrigation 118", ...) beside ordinary prose paragraphs; page 2 is a west-to-east bar chart with a legend and ~25 state-name labels scattered around it, plus more prose. Measured through this repo\'s TEXT path 2026-08-20: 2 pages, 10,048 chars (5,024 chars/page), 1 heading, 0 junkHeadings, 37 paragraphs, 0 reviewBlocks (the text path has no review-marking pass). Measured through this repo\'s OCR path (forced `--ocr`, which renders and re-recognizes every page regardless of the existing text layer) the same day: 2 pages, ~8.4s wall, 9,842 chars, 3 headings (0 junk), 16 paragraphs, 2 floats, 1 reviewBlock, 62 lowConfidenceWords (14 on page 1, 48 on page 2) — the page-2 state-name scatter OCRs into garbage ("ORLAERLR", "D.@.L2.0", "XA", "Sp?", ...), reproducing the tool\'s worst known defect class (see this file\'s header comment) while every recognized word still lands in the markdown (0 missing, auditWords). Confirmed deterministic across 2 repeated OCR runs: identical report numbers and an identical (sorted-equal) 1,460-line recognized-word dump both times.',
  },
  {
    name: 'ccitt.pdf',
    url: 'https://raw.githubusercontent.com/ocrmypdf/OCRmyPDF/v16.10.0/tests/resources/ccitt.pdf',
    sha256: '5f4b129bf0eb0d32358a917cd1754c6fd68cac589ad79076b6d0191ebe84f0f1',
    bytes: 103856,
    // Pinned to the immutable v16.10.0 tag, same rationale as c02-22.pdf above.
    license: "CC-BY-SA-4.0 — SPDX header on OCRmyPDF's tests/resources/README.rst covers the resources directory; that README's provenance table credits this scan to Forat Electronics (Copyright (C) 1985), same source family as c02-22.pdf.",
    what: 'A CCITTFax-encoded bitonal scan of a two-column LinnSequencer product sheet — a genuinely CCITT/JBIG2-class B&W page image, not a photo. This is the regression fixture for the pdf-open.ts wasmUrl fix: without `wasmUrl` wired into pdfjs 6.x\'s getDocument() call, this page rendered BLANK and OCR recognized ~nothing; with it, the text path correctly detects an image-only page (~1 char/page) and auto-falls back to OCR, which recognizes ~728 words / ~4,500 chars including "LinnSequencer" itself.',
  },
  {
    name: 'self-instruct.pdf',
    url: 'https://arxiv.org/pdf/2212.10560v2',
    sha256: '1f14747af9bb8faee2221965449d7685174da18f3421efd4f38ef9bc57d6944e',
    bytes: 4335548,
    license: 'CC-BY-4.0 — license badge on the arXiv abstract page (https://arxiv.org/abs/2212.10560)',
    what: 'Wang et al., "Self-Instruct: Aligning Language Models with Self-Generated Instructions" (ACL 2023) — a genuine two-column ACL-style layout, the clean two-column de-braiding fixture the corpus lacked (its predecessor, layoutparser.pdf, is single-column). Text path, 23 pages, ~88.5k chars. The abstract\'s sentences reconstruct contiguous and in order across the column break, which is what this fixture exists to pin.',
  },
  {
    name: 'cjk-survey.pdf',
    url: 'https://arxiv.org/pdf/2504.00977v2',
    sha256: 'e4e0b66e7f5f5d3f6bcb173731e808d05a3663a68bd1752383dcccea399e34c0',
    bytes: 1695687,
    license: 'CC-BY-SA-4.0 — license badge on the arXiv abstract page (https://arxiv.org/abs/2504.00977)',
    what: 'Qiu et al., "Chinese Grammatical Error Correction: A Survey" — the corpus\'s CJK fixture, a 110-page/1.7MB Chinese-language paper. Its point: openDocument() (the text path\'s pdfjs seam) opens PDFs with no cMaps wired in at all, yet CJK glyphs still decode to real codepoints rather than falling back to replacement chars; this pins that. Text path only (the OCR engine is English-only) and fast (well under 1s), so no OCR assertions are attached.',
  },
  {
    name: 'gao-24-107307.pdf',
    url: 'https://www.gao.gov/assets/gao-24-107307.pdf',
    sha256: '419f15b5925befbec02b5493434e83dfa99dbb7dc16c1455ef4f021e66a3877c',
    bytes: 319147,
    license: 'U.S. Government work, public domain — GAO\'s copyright policy (gao.gov/copyright) states GAO\'s products "are not protected by copyright law in the United States and may be copied and distributed in their entirety without permission from GAO."',
    what: "A 13-page GAO letter report to Congress — the corpus's list fixture: several multi-line bulleted findings whose wrapped continuation lines must reconstruct back onto one bullet rather than reading as their own paragraphs. Text path; the markdown's bullets carry full multi-line sentences, confirming the reconstruction holds.",
  },
  {
    name: 'usgs-tm9a0.pdf',
    url: 'https://pubs.usgs.gov/tm/09/a0/tm9a0.pdf',
    sha256: 'c1c04a43ebeb2941aff17c4adf9740ce1b42f54ed7ef79b6a280d05b6713f2cd',
    bytes: 399313,
    license: 'U.S. Government work, public domain — same USGS copyright policy the usgs-fs20183035.pdf entry above cites.',
    what: 'USGS Techniques and Methods 9-A0 (General Introduction, National Field Manual for the Collection of Water-Quality Data), 11 pages — the deepest exercise of the char-weighted heading-size histogram in the corpus: its title/subtitle/chapter/section stack spans five distinct heading sizes (22/20/18/16/14pt), rendering as five distinct `#`...`#####` levels. Text path.',
  },
];

class CorpusNetworkError extends Error {}
export class CorpusChecksumError extends Error {}

// Test-only escape hatch: when set, downloads fail immediately as if the
// network were down, so a test can assert corpusPath() resolves to null without depending on the real network. See public-corpus.test.ts.
const NO_NETWORK_ENV = 'PDF_TO_MD_CORPUS_NO_NETWORK';

/**
 * Fetch-once cache: returns the cached path if present, else calls
 * `build(stagingPath)` and atomically renames it on success — a throw leaves the staging file un-renamed, never masquerading as cached.
 */
export async function cached(key: string, build: (stagingPath: string) => Promise<void>): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const dest = path.join(CACHE_DIR, key);
  if (existsSync(dest)) return dest;

  const staging = `${dest}.building`;
  rmSync(staging, { force: true });
  await build(staging);
  renameSync(staging, dest);
  return dest;
}

async function downloadAndVerify(entry: CorpusEntry, stagingPath: string): Promise<void> {
  if (process.env[NO_NETWORK_ENV]) {
    throw new CorpusNetworkError(`network disabled via ${NO_NETWORK_ENV} (test-only offline simulation)`);
  }

  let res: Response;
  try {
    res = await fetch(entry.url, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new CorpusNetworkError(`fetch failed for ${entry.name} <${entry.url}>: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new CorpusNetworkError(`fetch ${entry.name} <${entry.url}> returned HTTP ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  // Hash the bytes actually written to disk (not the in-memory buffer), so a mismatch deletes the staging file itself.
  writeFileSync(stagingPath, buf);
  const hash = createHash('sha256').update(buf).digest('hex');
  if (hash !== entry.sha256) {
    rmSync(stagingPath, { force: true });
    throw new CorpusChecksumError(`corpus checksum mismatch for ${entry.name}: expected sha256 ${entry.sha256} (${entry.bytes} bytes), got ${hash} (${buf.length} bytes) — upstream file changed or the pinned hash in test/lib/corpus.ts is stale`);
  }
}

/**
 * Resolves to the cached path, downloading and verifying on first use.
 * Resolves to null (never throws) on network trouble, so a caller can skip; a checksum mismatch is a real problem and throws instead (CorpusChecksumError).
 */
export async function corpusPath(name: string): Promise<string | null> {
  const entry = CORPUS.find((e) => e.name === name);
  if (!entry) {
    throw new Error(`corpusPath: unknown corpus entry ${JSON.stringify(name)} — known: ${CORPUS.map((e) => e.name).join(', ')}`);
  }

  try {
    return await cached(entry.name, (staging) => downloadAndVerify(entry, staging));
  } catch (err) {
    if (err instanceof CorpusNetworkError) {
      console.error(`corpus: ${entry.name} unavailable, skipping (${err.message})`);
      return null;
    }
    throw err;
  }
}
