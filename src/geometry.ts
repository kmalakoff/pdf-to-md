// geometry.ts — OCR-path pass 2: words -> lines/columns/floats. Input is
// flat words (normalized page coords, origin bottom-left, y up), not pre-clustered line observations.
export interface Word {
  text: string;
  x: number; // rect.minX
  y: number; // rect.minY
  w: number; // rect.width
  h: number; // rect.height
  // 0-100 (tesseract.js's own `confidence` field, not `conf`). Optional —
  // passthrough only; see report.ts's LOW_CONFIDENCE_THRESHOLD for the consumer.
  confidence?: number;
}

/** A `Word` with its page number — the shared shape behind both the OCR
 * engine's own output (tesseract.ts) and the replay input contract (extract.ts's OcrWordInput). */
export interface PageWord extends Word {
  page: number;
}

export interface OcrLine {
  text: string;
  x: number; // rect.minX, used for float-alignment and indentation checks
  width: number; // rect.width, used for the float width check
  midY: number;
  h: number; // char-weighted dominant constituent height
  col: number;
  // Constituent words, left-to-right (same order as `text`'s tokens) — carries
  // word identity through row-building for analyze()'s block->word linkage.
  words: Word[];
}

export interface PageOCR {
  lines: OcrLine[];
  // Decorative fragment candidates (src/emit.ts's floats aside), kept as full
  // OcrLine so callers recover both the printed text and constituent words.
  floats: OcrLine[];
  pitch: number;
}

/** Tuning knobs for the OCR-path geometry pass (CLI: `--float-*`/`--para-gap`/
 * `--heading-scale`/`--col-*`/`--line-*`). See DEFAULT_TUNING for defaults. */
export interface Tuning {
  /** fragments with more words than this are body text, not decoration */
  floatMaxWords: number;
  /** fraction of page width above which a fragment is too wide to be
   * decoration */
  floatMaxWidth: number;
  /** how far a fragment's left edge must sit from its column edge to be
   * decoration */
  floatMargin: number;
  /** a vertical gap this many times the line pitch is a paragraph break */
  paraGap: number;
  /** lines taller than this times body height are headings */
  headingScale: number;
  /** boxes wider than this are excluded from gutter detection */
  colMaxWidth: number;
  /** fractional x of the two-column midpoint */
  colSplit: number;
  /** vertical distance within which two boxes are the same line */
  lineYTol: number;
  /** same-line boxes with a larger height ratio don't merge */
  lineHeightRatio: number;
}

/** Measured defaults; derivation in `test/unit/tuning.test.ts`. lineHeightRatio
 * 2.4 = pair-F1 plateau edge (0.924@1.6 -> 0.995@2.4, 9,471 pairs, 2026-08-16). */
export const DEFAULT_TUNING: Tuning = {
  floatMaxWords: 3,
  floatMaxWidth: 0.15,
  floatMargin: 0.008,
  paraGap: 1.6,
  headingScale: 2.0,
  colMaxWidth: 0.55,
  colSplit: 0.5,
  lineYTol: 0.006,
  lineHeightRatio: 2.4,
};

// Two-column decision (test/unit/column-break.test.ts): gutter ink <=0.017
// (2-col) vs >=0.047 (1-col) measured over 100 baseline pages, cut 0.03.
export const MAX_GUTTER_INK_FRAC = 0.03;

// Near-empty pages (e.g. a 2-word title page) have no gutter ink either, so
// a word-count floor is needed too; genuine columns measure >=76 words.
export const MIN_COL_WORDS = 10;

// lineYTol is an absolute page fraction measured on body text, but a word's
// box grows downward with its descenders, so its midpoint sits lower than a
// descenderless neighbour's on the same printed line. At body size that offset
// is ~0.003 (inside the tolerance); on 56pt display type it is ~0.007 (outside
// it), which splits one heading into two rows that then emit in midY order
// ("Open Road" -> "Road Open"). A descender is ~21% of the em, so the offset is
// ~11% of the taller box; 0.2 clears it with margin and still sits far below any
// line pitch. Body rows are unaffected: 0.2 * a body height stays under the floor.
export const LINE_Y_TOL_HEIGHT_FRAC = 0.2;

// Measured: a thin data rail is 11% of body words; the thinnest genuine
// column is 31% — 0.2 sits between.
export const MIN_COL_SHARE = 0.2;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Range = readonly [number, number];

const maxX = (r: Rect): number => r.x + r.w;
const maxY = (r: Rect): number => r.y + r.h;
const midX = (r: Rect): number => r.x + r.w / 2;
const midY = (r: Rect): number => r.y + r.h / 2;

function union(a: Rect, b: Rect): Rect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(maxX(a), maxX(b));
  const y1 = Math.max(maxY(a), maxY(b));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Overlap of a rect's x-span with a column x-range.
function xOverlap(r: Rect, range: Range): number {
  return Math.max(0, Math.min(maxX(r), range[1]) - Math.max(r.x, range[0]));
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
}

// Char-weighted dominant height: most characters wins (ties keep first) —
// same rule as src/lines.ts, so a small merged fragment can't promote a heading.
function dominantHeight(parts: Word[]): number {
  let best = parts[0];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].text.length > best.text.length) best = parts[i];
  }
  return best.h;
}

function assignColumn(rect: Rect, colRanges: Range[]): number {
  if (colRanges.length !== 2) return 0;
  const l = xOverlap(rect, colRanges[0]);
  const r = xOverlap(rect, colRanges[1]);
  if (l !== r) return l > r ? 0 : 1;
  const centers = colRanges.map((rg) => (rg[0] + rg[1]) / 2);
  return Math.abs(midX(rect) - centers[0]) <= Math.abs(midX(rect) - centers[1]) ? 0 : 1;
}

// A column x-range from full-width body rows: short paragraph-final rows and
// decorative fragments must not stretch it.
function range(rects: Rect[]): Range | undefined {
  if (rects.length < 2) return undefined;
  return [Math.min(...rects.map((r) => r.x)), Math.max(...rects.map(maxX))];
}

interface Row {
  rect: Rect;
  words: Word[];
  band: number; // -1 (gutter band / n/a), 0 (left or single column), 1 (right)
}

// Groups same-visual-line words via lineYTol/lineHeightRatio, requiring band
// agreement; searches ALL open rows since per-word y drifts ~0.001 across a
// printed line, enough to interleave two lines' words in y-sorted order. The y
// tolerance scales with box height (LINE_Y_TOL_HEIGHT_FRAC) so display type,
// whose descenders shift a word's midpoint further, still groups as one row.
function buildRows(words: Word[], tuning: Tuning, bandOf: (w: Word) => number): Row[] {
  const rows: Row[] = [];
  // Sort order only affects which compatible row a tie lands in (every row
  // is searched) — top-to-bottom, left-to-right keeps results deterministic.
  const sorted = [...words].sort((a, b) => midY(b) - midY(a) || a.x - b.x);
  for (const w of sorted) {
    const band = bandOf(w);
    const target = rows.find((r) => {
      if (r.band !== band) return false;
      const yTol = Math.max(tuning.lineYTol, Math.max(r.rect.h, w.h) * LINE_Y_TOL_HEIGHT_FRAC);
      return Math.abs(midY(r.rect) - midY(w)) <= yTol && Math.max(r.rect.h, w.h) < Math.min(r.rect.h, w.h) * tuning.lineHeightRatio;
    });
    if (target) {
      target.words.push(w);
      target.rect = union(target.rect, w);
    } else {
      rows.push({ rect: { x: w.x, y: w.y, w: w.w, h: w.h }, words: [w], band });
    }
  }
  return rows;
}

function makeLine(parts: Word[], rect: Rect, col: number): OcrLine {
  const sorted = [...parts].sort((a, b) => a.x - b.x);
  const text = sorted.map((p) => p.text).join(' ');
  return {
    text,
    x: rect.x,
    width: rect.w,
    midY: midY(rect),
    h: dominantHeight(parts),
    col,
    words: sorted,
  };
}

// Word-geometry pass (render/recognize happens upstream, in the OCR engine).
// Body-height words band left/right before row-grouping; heading-height words group across the full width, so a title stays one line.
export function buildPageOCR(words: Word[], tuning: Tuning): PageOCR {
  if (!words.length) return { lines: [], floats: [], pitch: 0.012 };

  const colBand = 0.02;
  const colLeftCut = tuning.colSplit - colBand;
  const colRightCut = tuning.colSplit + colBand;

  const medianH = median(words.map((w) => w.h)) ?? 0.017;
  // Same literal `medianH * 2` used elsewhere for this gate — not
  // `tuning.headingScale`, a separate constant that happens to share the 2.0 default.
  const tallGate = medianH * 2;

  // Two-column decision (test/unit/column-break.test.ts): gutter ink <=0.017
  // (2-col) vs >=0.047 (1-col), cut 0.03; floors >=0.2 share/>=10 words per side.
  const bodyWords = words.filter((w) => w.h < tallGate);
  const gutterInk = bodyWords.filter((w) => w.x < tuning.colSplit && maxX(w) > tuning.colSplit).length;
  const leftPop = bodyWords.filter((w) => midX(w) < colLeftCut).length;
  const rightPop = bodyWords.filter((w) => midX(w) > colRightCut).length;
  const twoCol = leftPop >= MIN_COL_WORDS && rightPop >= MIN_COL_WORDS && leftPop >= bodyWords.length * MIN_COL_SHARE && rightPop >= bodyWords.length * MIN_COL_SHARE && gutterInk <= bodyWords.length * MAX_GUTTER_INK_FRAC;

  // Band by word CENTER, no dead band: a word box can touch the split exactly
  // (a box can touch the split exactly) and still belongs to its center's column — the twoCol
  // gate above already guarantees near-zero gutter ink.
  const bandOf = (w: Word): number => {
    if (!twoCol) return 0;
    return midX(w) < tuning.colSplit ? 0 : 1;
  };
  const tallRows = buildRows(
    words.filter((w) => w.h >= tallGate),
    tuning,
    () => 0
  );
  const normalRows = buildRows(
    words.filter((w) => w.h < tallGate),
    tuning,
    bandOf
  );
  const rows = [...tallRows, ...normalRows];

  // Column ranges from body rows (height <= medianH*1.6): two-col ranges use
  // rows 0.2-0.55 wide; single-col has no upper bound (full-width rows ARE the column).
  let colRanges: Range[];
  if (twoCol) {
    const wideRows = rows.filter((r) => r.rect.w >= 0.2 && r.rect.w <= 0.55 && r.rect.h <= medianH * 1.6);
    const left = range(wideRows.filter((r) => r.band === 0).map((r) => r.rect));
    const right = range(wideRows.filter((r) => r.band === 1).map((r) => r.rect));
    colRanges = [left, right].filter((r): r is Range => r !== undefined);
  } else {
    const wideRows = rows.filter((r) => r.rect.w >= 0.2 && r.rect.h <= medianH * 1.6);
    const single = range(wideRows.map((r) => r.rect));
    colRanges = single !== undefined ? [single] : [];
  }

  const lines: OcrLine[] = rows.map((row) => makeLine(row.words, row.rect, assignColumn(row.rect, colRanges)));
  lines.sort((a, b) => a.col - b.col || b.midY - a.midY);

  // Float detection: short+narrow+misaligned, rescued into body when it
  // hangs under a body line like a paragraph continuation (same col, gap<=paraGap x pitch, x-overlap) — protects a centered paragraph's short last line.
  const preGaps: number[] = [];
  for (let k = 1; k < lines.length; k++) {
    if (lines[k].col === lines[k - 1].col) {
      const g = lines[k - 1].midY - lines[k].midY;
      if (g > 0.0005) preGaps.push(g);
    }
  }
  const provisionalPitch = median(preGaps) ?? 0.012;
  const colStarts = new Map<number, number>();
  colRanges.forEach((r, i) => {
    colStarts.set(i, r[0]);
  });
  const body: OcrLine[] = [];
  const floatCandidates: OcrLine[] = [];
  // Display-size junk (e.g. "1/3" at 68pt, 0.179 wide vs the 0.15 cap)
  // escapes the narrow float test; caught here by junk text + isolation (no adjacent tall line within 2.2x height).
  const tallLines = lines.filter((l) => l.h >= tallGate);
  for (const line of lines) {
    const wordCount = line.text.split(' ').filter(Boolean).length;
    const start = colStarts.get(line.col);
    const short = wordCount <= tuning.floatMaxWords && start !== undefined && Math.abs(line.x - start) > tuning.floatMargin;
    const displayJunkFragment =
      short &&
      line.h >= tallGate &&
      !/[A-Za-z]{3}/.test(line.text) &&
      // Same-column only, matching emitPage's heading-run gather — a heading
      // in the OTHER column can be y-adjacent without composing with this one.
      !tallLines.some((other) => other !== line && other.col === line.col && Math.abs(other.midY - line.midY) < Math.max(other.h, line.h) * 2.2);
    const looksDecorative = displayJunkFragment || (short && line.width < tuning.floatMaxWidth);
    const paragraphAdjacent =
      looksDecorative &&
      body.some((b) => {
        if (b.col !== line.col) return false;
        const gap = b.midY - line.midY;
        if (gap <= 0 || gap > tuning.paraGap * provisionalPitch) return false;
        const overlap = Math.min(b.x + b.width, line.x + line.width) - Math.max(b.x, line.x);
        return overlap >= line.width * 0.5;
      });
    if (looksDecorative && !paragraphAdjacent) {
      floatCandidates.push(line);
    } else {
      body.push(line);
    }
  }
  // One float per candidate row, in line order — no clustering of adjacent
  // candidates: replay against the frozen baseline regressed ~30 pages when tried.
  const floats = floatCandidates;

  // Line pitch = median vertical gap between consecutive same-column lines.
  const gaps: number[] = [];
  for (let k = 1; k < body.length; k++) {
    if (body[k].col === body[k - 1].col) {
      const g = body[k - 1].midY - body[k].midY;
      if (g > 0.0005) gaps.push(g);
    }
  }
  return { lines: body, floats, pitch: median(gaps) ?? 0.012 };
}

// Document-wide height histogram -> heading levels

// Bucket heights to 0.002 of page height so histogram keys are stable.
export function bucket(h: number): number {
  return Math.round(h * 500) / 500;
}

// `pages` are the already-body-only (post-float-filtering) PageOCR results.
export function headingLevels(pages: PageOCR[], tuning: Tuning): { bodyH: number; levelOf: Map<number, number> } {
  const chars = new Map<number, number>();
  for (const p of pages) {
    for (const l of p.lines) {
      const b = bucket(l.h);
      chars.set(b, (chars.get(b) ?? 0) + l.text.length);
    }
  }
  // Most-common height wins; ties broken by first-encountered (deterministic;
  // char-count ties across real documents are not observed).
  let bodyH = 0;
  let bestCount = -1;
  for (const [k, v] of chars) {
    if (v > bestCount) {
      bestCount = v;
      bodyH = k;
    }
  }

  const levelOf = new Map<number, number>();
  let level = 3; // "### pN" page markers occupy level 3
  let rep: number | null = null;
  const sizes = [...chars.keys()].filter((s) => s > bodyH * tuning.headingScale).sort((a, b) => b - a);
  for (const s of sizes) {
    if (rep === null || s < rep * 0.8) {
      level = Math.min(6, level + 1);
      rep = s;
    }
    levelOf.set(s, level);
  }
  return { bodyH, levelOf };
}
