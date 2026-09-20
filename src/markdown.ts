// Pass 3: lines -> markdown. Structure is measured, not guessed — heading
// levels come from the font-height histogram, hyphen-closes only against a dictionary (see the inline comments below for each rule).
import { getDict } from './dict.ts';
import { pageMarkerLine } from './page-marker.ts';
import type { AnalysisBlock, BuildMarkdownOptions, Line, MarkdownPage, MarkdownResult, MarkdownStats, PageLines } from './types.ts';

const GLYPH = /^[•◦▪▫●○·‣⁃]$/;
const BULLETS = /^(?:[•◦▪▫●○·‣⁃]\s*)+/;

export function buildMarkdown(pageLines: PageLines[], heightChars: Map<number, number>, opts: BuildMarkdownOptions = {}): MarkdownResult {
  // body height = char-weighted mode; headings are the rarer, larger sizes.
  // The 1.35 multiplier keeps emphasized body text out of the outline.
  const bodyH = [...heightChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const headingSizes = [...heightChars.keys()].filter((h) => h > bodyH * 1.35).sort((a, b) => b - a);
  // with page markers on, content headings start below the page ### level;
  // sizes beyond the ###### budget share level 6 rather than being dropped
  const offset = opts.pageMarkers ? 3 : 0;
  const levelOf = new Map(headingSizes.slice(0, 6).map((h, i) => [h, Math.min(6, i + 1 + offset)]));

  const out: string[] = [];
  const blockPages = new Map<number, AnalysisBlock[]>();
  const stats: MarkdownStats = {
    headings: 0,
    listItems: 0,
    paragraphs: 0,
    joinedPairs: 0,
    reflowed: 0,
    callouts: 0,
    closedHyphens: 0,
  };
  let currentPage = 0;
  let para: { text: string; wordIndexes: number[] }[] = [];

  const addBlock = (block: AnalysisBlock) => {
    const blocks = blockPages.get(currentPage);
    if (blocks) blocks.push(block);
    else blockPages.set(currentPage, [block]);
  };

  // a label line ending in ':' whose next line is a bare number belongs on one line
  function attachValue(label: string, lines: Line[], i: number): { text: string; last: number } {
    const j = i + 1;
    if (/[:：]\s*$/.test(label) && j < lines.length && /^[0-9][\d.,]*%?$/.test(lines[j].text)) {
      stats.joinedPairs++;
      return { text: `${label} ${lines[j].text}`, last: j };
    }
    return { text: label, last: i };
  }
  const flush = () => {
    if (!para.length) return;
    const text = para
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+([,.;:%])/g, '$1');
    out.push(text);
    out.push('');
    addBlock({ type: 'paragraph', text, wordIndexes: para.flatMap((part) => part.wordIndexes) });
    stats.paragraphs++;
    para = [];
  };
  // append a wrapped line to the open paragraph, resolving a line-final hyphen
  const appendToPara = (line: Line, text: string) => {
    const prev = para.at(-1);
    if (prev && /\w-$/.test(prev.text)) {
      // a bare " -" is punctuation, not a wrapped word
      const head = prev.text.replace(/-$/, '').split(/\s/).pop() as string;
      const tail = (text.split(/\s/)[0] ?? '').replace(/[^A-Za-z-]/g, '').split('-')[0];
      const close = getDict().has((head + tail).toLowerCase());
      if (close) stats.closedHyphens++;
      para[para.length - 1].text = prev.text.replace(/-$/, close ? '' : '-') + text;
      para[para.length - 1].wordIndexes.push(...line.wordIndexes);
    } else para.push({ text, wordIndexes: [...line.wordIndexes] });
  };

  for (const { page, lines } of pageLines) {
    currentPage = page;
    if (opts.pageMarkers) {
      flush();
      out.push(pageMarkerLine(page));
      out.push('');
    }
    if (!lines.length) continue;
    const indentBase = Math.min(...lines.map((l) => l.x));

    for (let i = 0; i < lines.length; i++) {
      let { text, h, x } = lines[i];
      const prevLine = i > 0 ? lines[i - 1] : null;
      // a column change or a vertical jump wider than a blank line ends the paragraph
      if (para.length && prevLine && (lines[i].col !== prevLine.col || lines[i].y - prevLine.y > h * 2.2)) flush();

      // A large-font line opens a run: gather the consecutive same-size lines
      // below it (a title wraps across lines). A short merged run is one heading; a long one is a callout/pull-quote in a bigger face — prose, not structure — and becomes a blockquote.
      if (levelOf.has(h) && !BULLETS.test(text)) {
        const run = [lines[i]];
        while (i + 1 < lines.length && lines[i + 1].h === h && lines[i + 1].col === lines[i].col && lines[i + 1].y - lines[i].y < h * 2.2 && !BULLETS.test(lines[i + 1].text)) run.push(lines[++i]);
        // join wrapped title lines, resolving line-final hyphens like body text
        const merged = run
          .map((line) => line.text)
          .reduce((acc, part) => (/\w-$/.test(acc) ? acc.replace(/-$/, getDict().has(((acc.replace(/-$/, '').split(/\s/).pop() as string) + (part.split(/\s/)[0] ?? '').replace(/[^A-Za-z-]/g, '').split('-')[0]).toLowerCase()) ? '' : '-') + part : `${acc} ${part}`))
          .replace(/\s+([,.;:%])/g, '$1');
        const wordIndexes = run.flatMap((line) => line.wordIndexes);
        flush();
        if (merged.length > 150) {
          out.push(`> ${merged}`);
          out.push('');
          addBlock({ type: 'paragraph', text: `> ${merged}`, wordIndexes });
          stats.callouts++;
        } else {
          const level = levelOf.get(h) as number;
          out.push(`${'#'.repeat(level)} ${merged}`);
          out.push('');
          addBlock({ type: 'heading', text: merged, level, wordIndexes });
          stats.headings++;
        }
        continue;
      }

      // Lines can carry several stacked glyphs ("• ▪") from nested source lists.
      const stripped = text.replace(BULLETS, '').trim();
      const wasBullet = stripped !== text;
      if (wasBullet) text = stripped;

      // bullet with nothing left on the line: attach the following line's text
      if ((!text || GLYPH.test(text)) && i + 1 < lines.length) {
        flush();
        const depth = Math.max(0, Math.round((x - indentBase) / 18));
        const itemLines = [lines[i], lines[++i]];
        let label = lines[i].text.replace(BULLETS, '').trim();
        while (!label && i + 1 < lines.length) {
          // stacked glyphs
          itemLines.push(lines[++i]);
          label = lines[i].text.replace(BULLETS, '').trim();
        }
        const attached = attachValue(label, lines, i);
        if (attached.last !== i) itemLines.push(lines[attached.last]);
        i = attached.last;
        const itemText = `${'  '.repeat(depth)}- ${attached.text}`;
        out.push(itemText);
        addBlock({ type: 'paragraph', text: itemText, tight: true, wordIndexes: itemLines.flatMap((line) => line.wordIndexes) });
        stats.listItems++;
        continue;
      }
      // glyph(s) followed by text on the same line
      if (wasBullet) {
        flush();
        const depth = Math.max(0, Math.round((x - indentBase) / 18));
        const itemLines = [lines[i]];
        const attached = attachValue(text, lines, i);
        if (attached.last !== i) itemLines.push(lines[attached.last]);
        i = attached.last;
        const itemText = `${'  '.repeat(depth)}- ${attached.text}`;
        out.push(itemText);
        addBlock({ type: 'paragraph', text: itemText, tight: true, wordIndexes: itemLines.flatMap((line) => line.wordIndexes) });
        stats.listItems++;
        continue;
      }
      // `label:` on its own line followed by a bare value -> keep together
      if (/[:：]\s*$/.test(text) && i + 1 < lines.length && /^[0-9][\d.,]*%?$/.test(lines[i + 1].text)) {
        flush();
        const itemText = `- ${text} ${lines[++i].text}`;
        out.push(itemText);
        addBlock({ type: 'paragraph', text: itemText, tight: true, wordIndexes: [...lines[i - 1].wordIndexes, ...lines[i].wordIndexes] });
        stats.joinedPairs++;
        continue;
      }
      // otherwise body text: re-flow wrapped lines into a paragraph
      appendToPara(lines[i], text);
      if (/[.!?:]$/.test(text)) flush();
      else stats.reflowed++;
    }
    flush();
  }
  flush();

  const md = `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
  const pages: MarkdownPage[] = pageLines.map(({ page }) => ({ page, blocks: blockPages.get(page) ?? [] }));
  return { md, stats, bodyH, headingSizes, pages };
}
