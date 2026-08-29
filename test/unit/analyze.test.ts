// analyze.test.ts — analyze()/toMarkdown()/toText() and the shipped auditor (auditWords).
// Direct-import coverage (src/index.ts only, never bin/ — see api.test.ts's header) plus one CLI round-trip for the raw word-replay contract.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Analysis, OcrWordInput } from '../../src/index.ts';
import { analyze, auditWords, extractOcr, PdfToMdError, toMarkdown, toText } from '../../src/index.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Multiset (bag-of-tokens) comparison, not string equality — a block's literal `text` can
// legitimately differ from its words joined by spaces (a hyphen join merges "creat-"+"Ive" -> "creatIve"), so correctness means the resolved word SET matches, not exact re-join.
function tokenBag(s: string): string[] {
  return normalize(s).split(/\s+/).filter(Boolean);
}

describe('analyze(): OCR fixture shape and wordIndexes correctness', () => {
  it('every block.wordIndexes resolves in range and covers exactly the words composing its text (ocr-single.pdf)', async () => {
    const analysis = await analyze(fixturePath('ocr-single.pdf'), { path: 'ocr' });
    assert.equal(analysis.report.path, 'ocr');
    assert.equal(analysis.outputVersion, analysis.report.outputVersion);
    assert.ok(analysis.pages.length >= 1);

    for (const page of analysis.pages) {
      const wordCount = page.words.length;
      for (const block of page.blocks) {
        assert.ok(['heading', 'paragraph', 'float', 'review'].includes(block.type));
        assert.ok(Array.isArray(block.wordIndexes));
        for (const idx of block.wordIndexes) {
          assert.ok(Number.isInteger(idx) && idx >= 0 && idx < wordCount, `index ${idx} out of range (page has ${wordCount} words)`);
        }
        // Every token the constituent words contribute must appear in the block's rendered text
        // and nothing else sneaks in (heading/paragraph text is built ONLY from those words, per emit.ts) — checked as a normalized-token multiset.
        const fromWords = tokenBag(block.wordIndexes.map((i) => page.words[i].text).join(' '));
        const fromText = tokenBag(block.type === 'float' ? block.text.replace(/^> \[floats\] /, '') : block.type === 'review' ? block.text.replace(/^> \[review: [^\]]*\] /, '') : block.text.replace(/^> /, ''));
        // Weak multiset containment: a hyphen join can fuse two tokens into one, so exact bag
        // equality isn't always true — this only checks no word vanishes or appears from nowhere.
        const joinedFromWords = fromWords.join('');
        const joinedFromText = fromText.join('');
        assert.equal(joinedFromWords, joinedFromText, `word set mismatch for a ${block.type} block: words gave "${joinedFromWords}", text gave "${joinedFromText}"`);
      }
    }
  });

  it('page words carry box + confidence (OCR path is genuinely per-word, not line-granularity)', async () => {
    const analysis = await analyze(fixturePath('ocr-single.pdf'), { path: 'ocr' });
    const w = analysis.pages[0].words[0];
    assert.equal(typeof w.text, 'string');
    assert.equal(typeof w.box.x, 'number');
    assert.equal(typeof w.box.y, 'number');
    assert.equal(typeof w.box.w, 'number');
    assert.equal(typeof w.box.h, 'number');
    assert.equal(typeof w.confidence, 'number');
  });
});

describe('analyze(): text path (documented coarser granularity)', () => {
  it('produces a well-formed Analysis whose toMarkdown/toText both render without throwing', async () => {
    const analysis = await analyze(fixturePath('text-single.pdf'));
    assert.equal(analysis.report.path, 'text');
    const md = toMarkdown(analysis);
    assert.match(md, /Garden Notes/);
    const txt = toText(analysis);
    assert.match(txt, /Garden Notes/);
    assert.doesNotMatch(txt, /^#/m);
  });
});

describe('AnalysisWord.box: ONE coordinate contract across paths (normalized [0,1], origin bottom-left, y up)', () => {
  // Range alone doesn't pin the contract — an inverted y axis still lands in [0,1] (a
  // top-of-page heading could measure y=0.065 instead of 0.935); reading order requires the first word to sit HIGHER (larger y) than the last on both paths.
  it('y increases upward on both paths: reading order runs high-y to low-y', async () => {
    const textAnalysis = await analyze(fixturePath('text-single.pdf'));
    const ocrAnalysis = await analyze(fixturePath('ocr-single.pdf'), { path: 'ocr' });

    for (const [label, analysis] of [
      ['text', textAnalysis],
      ['ocr', ocrAnalysis],
    ] as const) {
      const words = analysis.pages[0].words;
      assert.ok(words.length >= 2, `${label} path: need at least two words to check direction`);
      const first = words[0];
      const last = words[words.length - 1];
      assert.ok(first.box.y > last.box.y, `${label} path: first word ${JSON.stringify(first.text)} (y=${first.box.y}) should sit ABOVE last word ${JSON.stringify(last.text)} (y=${last.box.y}) — y must increase upward`);
    }
  });

  it('every word box on both the TEXT path and the OCR path lands in [0,1]', async () => {
    const textAnalysis = await analyze(fixturePath('text-single.pdf'));
    const ocrAnalysis = await analyze(fixturePath('ocr-single.pdf'), { path: 'ocr' });

    for (const [label, analysis] of [
      ['text', textAnalysis],
      ['ocr', ocrAnalysis],
    ] as const) {
      let checked = 0;
      for (const page of analysis.pages) {
        for (const w of page.words) {
          for (const axis of ['x', 'y', 'w', 'h'] as const) {
            const v = w.box[axis];
            assert.ok(Number.isFinite(v), `${label} path: box.${axis} not finite (word ${JSON.stringify(w.text)})`);
            assert.ok(v >= 0 && v <= 1, `${label} path: box.${axis}=${v} out of [0,1] (word ${JSON.stringify(w.text)})`);
          }
          checked++;
        }
      }
      assert.ok(checked > 0, `${label} path: no words to check`);
    }
  });

  it('the TEXT path box.w stays 0 (not measured) even after unit normalization — normalizing never fakes a width', async () => {
    const analysis = await analyze(fixturePath('text-single.pdf'));
    const allZero = analysis.pages.every((p) => p.words.every((w) => w.box.w === 0));
    assert.ok(allZero, 'text-path box.w must stay exactly 0');
  });
});

describe('toMarkdown/toText: fail-fast ANALYSIS_INPUT on a malformed Analysis', () => {
  it('throws PdfToMdError/ANALYSIS_INPUT on an out-of-range wordIndexes entry, before any output', async () => {
    const analysis = await analyze(fixturePath('ocr-single.pdf'), { path: 'ocr' });
    const corrupt: Analysis = JSON.parse(JSON.stringify(analysis));
    corrupt.pages[0].blocks[0].wordIndexes = [corrupt.pages[0].words.length + 5];
    assert.throws(
      () => toMarkdown(corrupt),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError);
        assert.equal(err.code, 'ANALYSIS_INPUT');
        return true;
      }
    );
    assert.throws(
      () => toText(corrupt),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError);
        assert.equal(err.code, 'ANALYSIS_INPUT');
        return true;
      }
    );
  });

  // AnalysisBlock.level contract (src/types.ts): required integer 1-6 on a heading, forbidden
  // elsewhere — validated fail-fast (previously level:-1 raised a raw RangeError, level:99 emitted 99 '#'s).
  const withBlock = (block: object): Analysis =>
    ({
      outputVersion: 1,
      report: { path: 'ocr' },
      pages: [{ page: 1, words: [{ text: 'x', box: { x: 0, y: 0, w: 0, h: 0 } }], blocks: [block] }],
    }) as unknown as Analysis;
  const assertAnalysisInput = (analysis: Analysis) => {
    for (const render of [toMarkdown, toText]) {
      assert.throws(
        () => render(analysis),
        (err: unknown) => {
          assert.ok(err instanceof PdfToMdError, `expected PdfToMdError, got ${String(err)}`);
          assert.equal(err.code, 'ANALYSIS_INPUT');
          return true;
        }
      );
    }
  };

  for (const level of [-1, 0, 99, '3', undefined]) {
    it(`throws ANALYSIS_INPUT on a heading with level ${level === undefined ? 'missing' : JSON.stringify(level)}`, () => {
      const block: Record<string, unknown> = { type: 'heading', text: 'x', wordIndexes: [0] };
      if (level !== undefined) block.level = level;
      assertAnalysisInput(withBlock(block));
    });
  }

  it('throws ANALYSIS_INPUT on a non-heading block carrying a level (rejected, not ignored)', () => {
    assertAnalysisInput(withBlock({ type: 'paragraph', text: 'x', level: 2, wordIndexes: [0] }));
  });

  it('accepts a heading with a valid integer level 1-6 and renders it', () => {
    const md = toMarkdown(withBlock({ type: 'heading', text: 'x', level: 3, wordIndexes: [0] }));
    assert.match(md, /^### x$/m);
  });

  it('throws on a wrong-shaped object entirely (no partial output possible: it never returns a string)', () => {
    assert.throws(
      // @ts-expect-error deliberately wrong shape
      () => toMarkdown({ not: 'an analysis' }),
      (err: unknown) => {
        assert.ok(err instanceof PdfToMdError);
        assert.equal(err.code, 'ANALYSIS_INPUT');
        return true;
      }
    );
  });
});

describe('analyze(): merge/splice (no merge API — plain data + pure renderers)', () => {
  it('re-analyzing one page with different tuning and splicing it into the doc Analysis, toMarkdown works', async () => {
    const full = await analyze(fixturePath('ocr-badge.pdf'), { path: 'ocr' });
    const retuned = await analyze(fixturePath('ocr-badge.pdf'), {
      path: 'ocr',
      pages: { first: 1, last: 1 },
      tuning: { floatMaxWords: 0 }, // demonstrably changes behavior (see tuning.test.ts)
    });
    assert.equal(retuned.pages.length, 1);
    full.pages[0] = retuned.pages[0];
    const md = toMarkdown(full); // must not throw
    assert.ok(md.length > 0);
  });
});

describe('raw round-trip: words from an Analysis feed back through extractOcr and reproduce identical markdown', () => {
  it('ocr-single.pdf: analyze -> flatten words -> extractOcr({words}) -> same markdown', async () => {
    const analysis = await analyze(fixturePath('ocr-single.pdf'), { path: 'ocr' });
    const original = await extractOcr({ pdfPath: fixturePath('ocr-single.pdf') });

    const words: OcrWordInput[] = [];
    for (const page of analysis.pages) {
      for (const w of page.words) {
        words.push({ page: page.page, text: w.text, x: w.box.x, y: w.box.y, w: w.box.w, h: w.box.h, confidence: w.confidence });
      }
    }
    const replayed = await extractOcr({ words });
    assert.equal(replayed.markdown, original.markdown, 'replayed markdown must be byte-identical to the original extractOcr run');

    // toMarkdown(analysis) is byte-identical to extractOcr's own markdown for an OCR-origin
    // Analysis — same shared core (src/analyze.ts), not two implementations kept in sync by hand.
    assert.equal(toMarkdown(analysis), original.markdown);
  });
});

describe('severity-1 audit (shipped auditor) against a raw Analysis word list', () => {
  it('auditWords reports MISSING=0 against the markdown analyze() itself measured its report from', async () => {
    const analysis = await analyze(fixturePath('ocr-chart.pdf'), { path: 'ocr' });
    const md = toMarkdown(analysis);

    const dir = scratchDir('analyze-audit-');
    const wordsPath = path.join(dir, 'words.jsonl');
    const mdPath = path.join(dir, 'doc.md');
    const lines: string[] = [];
    for (const page of analysis.pages) {
      for (const w of page.words) lines.push(JSON.stringify({ page: page.page, text: w.text }));
    }
    writeFileSync(wordsPath, `${lines.join('\n')}\n`);
    writeFileSync(mdPath, md);

    const result = auditWords(wordsPath, mdPath);
    assert.equal(result.missing, 0, `expected MISSING=0, got: ${result.summaryLine}`);
  });
});

describe('audit subcommand: pdf-to-md audit <words.jsonl> <file.md>', () => {
  it('exits 0 and reports MISSING=0 on a clean pair', () => {
    const dump = path.join(scratchDir('audit-cli-'), 'words.jsonl');
    const { md, status: extractStatus } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', `--debug-words=${dump}`]);
    assert.equal(extractStatus, 0);
    const mdPath = `${dump}.md`;
    writeFileSync(mdPath, md);

    const result = run(['audit', dump, mdPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MISSING=0/);
  });

  it('exits 1 and reports the missing word when the markdown is missing a recognized word', () => {
    const dump = path.join(scratchDir('audit-cli-missing-'), 'words.jsonl');
    const { md, status: extractStatus } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', `--debug-words=${dump}`]);
    assert.equal(extractStatus, 0);
    const mdPath = `${dump}.md`;
    // Injected severity-1 loss: delete one recognized word's text from the
    // output the auditor is checking against.
    writeFileSync(mdPath, md.replace('valley', ''));

    const result = run(['audit', dump, mdPath]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /MISSING 1/);
    assert.match(result.stdout, /valley/);
  });
});

describe('--format md|txt|raw: each produces output on a fixture', () => {
  it('--format=md (default) and --format=md (explicit) match', () => {
    const a = run([fixturePath('text-single.pdf'), '--stdout']);
    const b = run([fixturePath('text-single.pdf'), '--stdout', '--format=md']);
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    assert.equal(a.md, b.md);
    assert.match(a.md, /^# Garden Notes$/m);
  });

  it('--format=txt produces reading-order plain text (no markdown headings)', () => {
    const { md, status } = run([fixturePath('text-single.pdf'), '--stdout', '--format=txt']);
    assert.equal(status, 0);
    assert.match(md, /Garden Notes/);
    assert.doesNotMatch(md, /^#/m);
  });

  it('--format=raw produces parseable Analysis JSON including the report', () => {
    const { md, status } = run([fixturePath('ocr-single.pdf'), '--stdout', '--ocr', '--format=raw']);
    assert.equal(status, 0);
    const parsed: Analysis = JSON.parse(md);
    assert.equal(parsed.report.path, 'ocr');
    assert.ok(Array.isArray(parsed.pages));
    assert.ok(parsed.pages[0].words.length > 0);
    assert.ok(parsed.pages[0].blocks.length > 0);
  });

  it('rejects an unknown --format value as a usage error', () => {
    const result = run([fixturePath('text-single.pdf'), '--stdout', '--format=xml']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--format must be one of/);
  });
});
