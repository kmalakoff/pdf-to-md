// audit.ts — the severity-1 audit instrument (README's "Design contract"),
// shipped as part of the product, not just a path into the source tree.
//
// Every recognized word (a --debug-words dump, or an Analysis page's
// `words`) must appear in its page's Markdown. Matching consumes evidence so
// a single output occurrence cannot satisfy repeated source occurrences.
//
// NOTE: no producer guarantees JSON key order in a --debug-words dump —
// parse, never grep.
import { readFileSync } from 'node:fs';
import { PdfToMdError } from './errors.ts';
import { foldTypographic } from './lines.ts';
import { bodyByPage } from './page-marker.ts';

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;
const HYPHEN_RE = /[\p{Pd}\u2212]\s*$/u;
const LINE_HYPHEN_RE = /^[\p{Pd}\u2212][ \t]*\r?\n[ \t]*$/u;
const INLINE_HYPHEN_RE = /^[\p{Pd}\u2212][ \t]*$/u;

interface Token {
  text: string;
  start: number;
  end: number;
  gapAfter: string;
}

interface SourceRun {
  page: number;
  tokens: number[];
  terminalHyphen: boolean;
  hyphenOnly: boolean;
  leadingWhitespace: boolean;
  trailingWhitespace: boolean;
  box?: Box;
}

interface PageEvidence {
  tokens: string[];
  sourcePairs: SourcePair[];
}

interface SourcePair {
  first: number;
  second: number;
  explicitHyphen: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AuditRecord {
  page: number;
  text: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

function tokens(text: string): Token[] {
  const folded = foldTypographic(text);
  WORD_RE.lastIndex = 0;
  const matches = [...folded.matchAll(WORD_RE)];
  return matches.map((match, index) => {
    const start = match.index as number;
    const end = start + match[0].length;
    const next = matches[index + 1];
    return {
      text: match[0].normalize('NFC').toLowerCase(),
      start,
      end,
      gapAfter: folded.slice(end, next?.index ?? folded.length),
    };
  });
}

function markdownText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/!\[[^\]]*\]\[[^\]]*\]/gu, ' ')
    .replace(/<img\b[^>]*>/giu, ' ')
    .replace(/<a\b[^>]*>/giu, ' ')
    .replace(/<\/a>/giu, ' ')
    .replace(/^\s*\[[^\]]+\]:[^\n]*$/gmu, ' ')
    .replace(/^>\s*\[(?:review:[^\]]*|floats)\]\s*/gmu, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, '$1');
}

function counter(items: Iterable<string>): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of items) m.set(item, (m.get(item) ?? 0) + 1);
  return m;
}

/** auditWords()'s result — the severity-1 no-silent-loss check. */
export interface AuditResult {
  /** JSON lines successfully parsed from the word dump */
  parsed: number;
  /** lines in the dump that were not parseable JSON; auditWords rejects
   * evidence with any such line */
  nonJsonSkipped: number;
  /** distinct page numbers present in the dump */
  pages: number;
  /** total recognized words across all pages in the dump */
  words: number;
  /** words present in the dump but not found verbatim on their page, BEFORE
   * hyphen-join/split repair is applied; always `>= missing` */
  strictDeficits: number;
  /** words genuinely absent from the markdown after repair-checking; `0` is
   * the only passing value (`pdf-to-md audit` exits nonzero otherwise) */
  missing: number;
  /** per-page detail for every page with at least one missing word (capped
   * sample of the missing tokens per page) */
  perPage: { page: number; missing: string[] }[];
  /** the one-line `parsed=… pages=… words=… strict_deficits=… MISSING=…`
   * summary, also the last entry of `lines` */
  summaryLine: string;
  /** every line `pdf-to-md audit` prints, in order: one per page with
   * missing words, then `summaryLine` */
  lines: string[];
}

/**
 * Audit a --debug-words dump against a Markdown file. Every recognized word
 * must land on its page. Invalid evidence or absent page provenance throws a
 * PdfToMdError with code `AUDIT_INPUT`.
 *
 * @param wordsPath path to a --debug-words JSON-lines dump (`{page, text, ...}` per line)
 * @param mdPath path to the markdown file to check the dump against
 */
export function auditWords(wordsPath: string, mdPath: string): AuditResult {
  const rec = new Map<number, PageEvidence>();
  let parsed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const runsByPage = new Map<number, SourceRun[]>();

  const wordsRaw = readFileSync(wordsPath, 'utf8');
  // A trailing "\n" at EOF must not yield a spurious final empty line; a
  // genuine blank line mid-file does count, as skipped.
  const rawLines = wordsRaw.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  for (const [lineIndex, rawLine] of rawLines.entries()) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) {
      skipped++;
      errors.push(`line ${lineIndex + 1} is not valid JSON`);
      continue;
    }
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      skipped++;
      errors.push(`line ${lineIndex + 1} is not valid JSON`);
      continue;
    }
    parsed++;
    if (!isAuditRecord(o)) {
      errors.push(`line ${lineIndex + 1} must contain a positive integer page and non-empty text`);
      continue;
    }
    let evidence = rec.get(o.page);
    if (!evidence) {
      evidence = { tokens: [], sourcePairs: [] };
      rec.set(o.page, evidence);
    }
    const runTokenDetails = tokens(o.text);
    const runTokens = runTokenDetails.map((token) => token.text);
    const start = evidence.tokens.length;
    evidence.tokens.push(...runTokens);
    for (let index = 0; index + 1 < runTokenDetails.length; index++) {
      if (INLINE_HYPHEN_RE.test(runTokenDetails[index].gapAfter)) {
        evidence.sourcePairs.push({ first: start + index, second: start + index + 1, explicitHyphen: true });
      }
    }
    const run = {
      page: o.page,
      tokens: runTokens.map((_, index) => start + index),
      terminalHyphen: HYPHEN_RE.test(o.text),
      hyphenOnly: /^[\p{Pd}\u2212]\s*$/u.test(o.text),
      leadingWhitespace: /^\s/u.test(o.text),
      trailingWhitespace: /\s$/u.test(o.text),
      box: recordBox(o),
    };
    const pageRuns = runsByPage.get(o.page);
    if (pageRuns) pageRuns.push(run);
    else runsByPage.set(o.page, [run]);
  }

  if (parsed === 0) errors.push('word dump contains no JSON records');
  if (rec.size === 0) errors.push('word dump contains no valid records');
  if ([...rec.values()].every((evidence) => evidence.tokens.length === 0)) errors.push('word dump contains no lexical tokens');
  for (const [page, runs] of runsByPage) {
    for (let index = 0; index + 1 < runs.length; index++) {
      const current = runs[index];
      const next = runs[index + 1];
      if (current.tokens.length > 0 && current.terminalHyphen && next.tokens.length > 0) {
        const evidence = rec.get(page) as PageEvidence;
        evidence.sourcePairs.push({ first: current.tokens[current.tokens.length - 1], second: next.tokens[0], explicitHyphen: true });
      }
      if (current.tokens.length === 1 && next.tokens.length === 1 && !current.terminalHyphen && !next.hyphenOnly && !current.trailingWhitespace && !next.leadingWhitespace && touchingFragments(current.box, next.box)) {
        const evidence = rec.get(page) as PageEvidence;
        evidence.sourcePairs.push({ first: current.tokens[0], second: next.tokens[0], explicitHyphen: false });
      }
      if (current.tokens.length === 0 || !next.hyphenOnly || index + 2 >= runs.length) continue;
      const afterHyphen = runs[index + 2];
      if (afterHyphen.tokens.length === 0) continue;
      const evidence = rec.get(page) as PageEvidence;
      evidence.sourcePairs.push({ first: current.tokens[current.tokens.length - 1], second: afterHyphen.tokens[0], explicitHyphen: true });
    }
  }
  if (errors.length > 0) throw auditInputError(errors);

  const md = readFileSync(mdPath, 'utf8');
  const out = bodyByPage(md);

  const lines: string[] = [];
  let total = 0;
  let strict = 0;
  const perPage: { page: number; missing: string[] }[] = [];
  const pages = [...rec.keys()].sort((a, b) => a - b);

  const absent = pages.filter((page) => !out.has(page));
  if (absent.length > 0) {
    const markers = absent.map((page) => `p${page}`).join(', ');
    throw auditInputError([`Markdown has no provenance marker for ${markers}; add "### pN" or "<!-- pN -->" for every dumped page`]);
  }

  for (const page of pages) {
    const evidence = rec.get(page) as PageEvidence;
    const output = tokens(markdownText(out.get(page) as string));
    const outputTokens = output.map((token) => token.text);
    const strictMissing = strictDeficits(evidence.tokens, outputTokens);
    strict += strictMissing;
    const missing = missingTokens(evidence, output);
    if (missing.length > 0) {
      total += missing.length;
      perPage.push({ page, missing });
      lines.push(`p${page}: MISSING ${missing.length}: ${pyRepr(missing.slice(0, 12))}`);
    }
  }

  const words = pages.reduce((sum, p) => sum + (rec.get(p)?.tokens.length ?? 0), 0);
  const summaryLine = `parsed=${parsed} non-json-skipped=${skipped} pages=${rec.size} words=${words} strict_deficits=${strict} MISSING=${total}`;
  lines.push(summaryLine);

  return {
    parsed,
    nonJsonSkipped: skipped,
    pages: rec.size,
    words,
    strictDeficits: strict,
    missing: total,
    perPage,
    summaryLine,
    lines,
  };
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<AuditRecord>;
  if (!(typeof record.page === 'number' && Number.isSafeInteger(record.page) && record.page > 0 && typeof record.text === 'string' && record.text.trim().length > 0)) return false;
  const geometry = [record.x, record.y, record.w, record.h];
  return geometry.every((field) => field === undefined) || (geometry.every((field) => typeof field === 'number' && Number.isFinite(field)) && (record.w as number) >= 0 && (record.h as number) >= 0);
}

function recordBox(record: AuditRecord): Box | undefined {
  if (record.x === undefined || record.y === undefined || record.w === undefined || record.h === undefined) return undefined;
  return { x: record.x, y: record.y, w: record.w, h: record.h };
}

function touchingFragments(first: Box | undefined, second: Box | undefined): boolean {
  if (!first || !second) return false;
  const height = Math.max(first.h, second.h);
  if (height === 0) return false;
  const gap = second.x - (first.x + first.w);
  // Fragment repairs are restricted to nearly touching runs on one baseline.
  return Math.abs(first.y - second.y) <= height * 0.25 && Math.abs(gap) <= height * 0.15;
}

function auditInputError(errors: string[]): PdfToMdError {
  return new PdfToMdError('AUDIT_INPUT', `audit evidence is invalid: ${errors.join('; ')}`);
}

function strictDeficits(source: string[], output: string[]): number {
  let deficits = 0;
  const outputCounts = counter(output);
  for (const [token, count] of counter(source)) deficits += Math.max(0, count - (outputCounts.get(token) ?? 0));
  return deficits;
}

function missingTokens(evidence: PageEvidence, output: Token[]): string[] {
  const sourceAvailable = new Set(evidence.tokens.map((_, index) => index));
  const outputAvailable = new Set(output.map((_, index) => index));
  const linePairs = lineHyphenPairs(output);
  const inlinePairs = inlineHyphenPairs(output);

  // Reserve literal occurrences before attempting a repair. A repair may join
  // several source tokens into one output token, so doing it first can steal
  // an occurrence required by an unrelated literal source token.
  for (const sourceIndex of [...sourceAvailable]) {
    const direct = output.findIndex((token, index) => outputAvailable.has(index) && token.text === evidence.tokens[sourceIndex]);
    if (direct < 0) continue;
    sourceAvailable.delete(sourceIndex);
    outputAvailable.delete(direct);
  }

  for (const pair of evidence.sourcePairs) {
    if (!sourceAvailable.has(pair.first) || !sourceAvailable.has(pair.second)) continue;
    const joined = evidence.tokens[pair.first] + evidence.tokens[pair.second];
    if (pair.explicitHyphen) {
      const hyphenated =
        inlinePairs.find(([first, second]) => outputAvailable.has(first) && outputAvailable.has(second) && output[first].text + output[second].text === joined) ?? linePairs.find(([first, second]) => outputAvailable.has(first) && outputAvailable.has(second) && output[first].text + output[second].text === joined);
      if (hyphenated) {
        sourceAvailable.delete(pair.first);
        sourceAvailable.delete(pair.second);
        outputAvailable.delete(hyphenated[0]);
        outputAvailable.delete(hyphenated[1]);
        continue;
      }
    }
    const direct = output.findIndex((token, index) => outputAvailable.has(index) && token.text === joined);
    if (direct >= 0) {
      sourceAvailable.delete(pair.first);
      sourceAvailable.delete(pair.second);
      outputAvailable.delete(direct);
    }
  }

  for (const sourceIndex of [...sourceAvailable]) {
    const split = linePairs.find(([first, second]) => outputAvailable.has(first) && outputAvailable.has(second) && output[first].text + output[second].text === evidence.tokens[sourceIndex]);
    if (!split) continue;
    sourceAvailable.delete(sourceIndex);
    outputAvailable.delete(split[0]);
    outputAvailable.delete(split[1]);
  }

  return [...sourceAvailable].map((index) => evidence.tokens[index]);
}

function lineHyphenPairs(output: Token[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < output.length; index++) {
    if (LINE_HYPHEN_RE.test(output[index].gapAfter)) pairs.push([index, index + 1]);
  }
  return pairs;
}

function inlineHyphenPairs(output: Token[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let index = 0; index + 1 < output.length; index++) {
    if (INLINE_HYPHEN_RE.test(output[index].gapAfter)) pairs.push([index, index + 1]);
  }
  return pairs;
}

// Renders a string list as ['a', 'b'] (single-quoted) to match frozen baseline comparisons byte-for-byte.
function pyRepr(items: string[]): string {
  return `[${items.map((s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(', ')}]`;
}
