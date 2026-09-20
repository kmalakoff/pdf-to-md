// page-marker.ts — page provenance shared by Markdown producers and readers.

/** The marker heading for page N, with no surrounding whitespace/newlines
 * (callers own their own blank-line formatting). */
export function pageMarkerLine(page: number): string {
  return `### p${page}`;
}

// Visible headings are emitted by this package; invisible comments preserve
// page provenance when a caller does not want headings in its final Markdown.
const MARKER_RE_SOURCE = '^(?:### p(\\d+)|<!-- p(\\d+) -->)\\r?$';

function markerPage(match: RegExpExecArray): number {
  return Number(match[1] ?? match[2]);
}

/** Is this line (already split, no trailing newline) a page-marker heading? */
export function isPageMarkerLine(line: string): boolean {
  return new RegExp(MARKER_RE_SOURCE, 'u').test(line);
}

/** Split markdown into per-marker body slices, in document order — one entry
 * PER OCCURRENCE (a duplicate "### pN" yields two entries; no slice is ever dropped). */
export function splitByPageMarker(md: string): { page: number; body: string }[] {
  const re = new RegExp(MARKER_RE_SOURCE, 'gmu');
  const markers: { page: number; index: number; end: number }[] = [];
  for (let m = re.exec(md); m !== null; m = re.exec(md)) markers.push({ page: markerPage(m), index: m.index, end: m.index + m[0].length });
  const out: { page: number; body: string }[] = [];
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].index : md.length;
    out.push({ page: markers[i].page, body: md.slice(markers[i].end, end) });
  }
  return out;
}

/** Per-page body text, duplicate-marker slices CONCATENATED — a word anywhere
 * on page N counts as on page N (the auditor's membership semantics). */
export function bodyByPage(md: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const { page, body } of splitByPageMarker(md)) out.set(page, (out.get(page) ?? '') + body);
  return out;
}

/** Count of visible or invisible page-provenance marker lines in `md`. */
export function countPageMarkers(md: string): number {
  return [...md.matchAll(new RegExp(MARKER_RE_SOURCE, 'gmu'))].length;
}
