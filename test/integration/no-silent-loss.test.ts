// no-silent-loss.test.ts — THE INVARIANT TEST for the OCR path's severity-1 contract
// (README's "Design contract"): every engine-recognized word must land somewhere in the output.

// Enforced via --debug-words=FILE (dumped pre column-assignment/line-merge/float-filter)
// against the same run's markdown — mechanical, not a read-through.

// The shipped auditor checks page-scoped, occurrence-aware evidence.

// Passes on ocr-centered.pdf/ocr-colbreak.pdf too: their known issues are placement bugs
// (relocated to floats / see column-break.test.ts), not disappearance.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { auditWords } from '@effortlessmotion/pdf-to-md';
import { safeRmSync } from 'fs-remove-compat';
import { debugWordsPath, readDebugWords } from '../lib/debug-words.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { run } from '../lib/run.ts';
import { scratchDir } from '../lib/tmp.ts';

const OCR_FIXTURES = ['ocr-single.pdf', 'ocr-twocol.pdf', 'ocr-badge.pdf', 'ocr-colbreak.pdf', 'ocr-centered.pdf'];

describe('no-silent-loss: every engine-recognized word lands somewhere in the output', () => {
  for (const name of OCR_FIXTURES) {
    it(`${name}: no dumped word is missing from the markdown`, () => {
      const dump = debugWordsPath();
      const { md } = run([fixturePath(name), '--stdout', '--ocr', `--debug-words=${dump}`]);
      const words = readDebugWords(dump).map((w) => w.text);
      assert.ok(words.length > 0, `--debug-words produced no words for ${name} — engine or flag broken`);
      const dir = scratchDir('no-silent-loss-');
      try {
        const mdPath = path.join(dir, `${name}.md`);
        writeFileSync(mdPath, md);
        const audit = auditWords(dump, mdPath);
        assert.equal(audit.missing, 0, `words recognized by the engine but missing from ${name}'s page-scoped markdown output: ${audit.summaryLine}`);
      } finally {
        safeRmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
