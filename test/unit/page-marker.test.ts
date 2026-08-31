// page-marker.test.ts — the shared "### pN" split. A duplicate marker must
// never silently drop a body slice (report: one row per occurrence; audit: slices concatenated).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { auditWords } from '@effortlessmotion/pdf-to-md';
import { bodyByPage, splitByPageMarker } from '../../src/page-marker.ts';
import { buildOcrReport } from '../../src/report.ts';
import { scratchDir } from '../lib/tmp.ts';

const DUP_MD = '### p1\nfoo alpha here.\n\n### p2\nbar bravo line.\n\n### p1\nbaz charlie tail.\n';

describe('page markers with a duplicate "### pN"', () => {
  it('splitByPageMarker keeps one entry per occurrence, in order', () => {
    const parts = splitByPageMarker(DUP_MD);
    assert.deepEqual(
      parts.map((p) => p.page),
      [1, 2, 1]
    );
    assert.match(parts[0].body, /foo alpha/);
    assert.match(parts[2].body, /baz charlie/);
  });

  it('bodyByPage concatenates duplicate slices so no text vanishes', () => {
    const byPage = bodyByPage(DUP_MD);
    assert.equal(byPage.size, 2);
    assert.match(byPage.get(1) as string, /foo alpha[\s\S]*baz charlie/);
  });

  it('buildOcrReport emits one pageStats row per marker occurrence', () => {
    const report = buildOcrReport({ md: DUP_MD });
    assert.equal(report.pages, 3);
    assert.equal(report.pageStats.length, 3);
    assert.deepEqual(
      report.pageStats.map((r) => r.page),
      [1, 2, 1]
    );
  });

  it('auditWords finds a word that sits in the FIRST duplicate slice', () => {
    const dir = scratchDir('page-marker-');
    const wordsPath = path.join(dir, 'words.jsonl');
    const mdPath = path.join(dir, 'out.md');
    writeFileSync(wordsPath, `${['alpha', 'charlie'].map((t) => JSON.stringify({ page: 1, text: t, x: 0, y: 0, w: 0.1, h: 0.01 })).join('\n')}\n`);
    writeFileSync(mdPath, DUP_MD);
    const result = auditWords(wordsPath, mdPath);
    assert.equal(result.missing, 0, `expected no missing words, got: ${result.summaryLine}`);
  });
});
