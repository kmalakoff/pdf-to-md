// no-silent-loss.test.ts — THE INVARIANT TEST for the OCR path's severity-1 contract
// (README's "Design contract"): every engine-recognized word must land somewhere in the output.

// Enforced via --debug-words=FILE (dumped pre column-assignment/line-merge/float-filter)
// against the same run's markdown — mechanical, not a read-through.

// Normalization mirrors src/audit.ts's auditWords() contract (lowercase, strip non-alnum,
// hyphen-join substring repair) — see there for the full rule, not restated here.

// Passes on ocr-centered.pdf/ocr-colbreak.pdf too: their known issues are placement bugs
// (relocated to floats / see column-break.test.ts), not disappearance.

import assert from 'node:assert/strict';
import { debugWordsPath, readDebugWords } from '../lib/debug-words.ts';
import { fixturePath } from '../lib/fixtures.ts';
import { run } from '../lib/run.ts';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
}

const OCR_FIXTURES = ['ocr-single.pdf', 'ocr-twocol.pdf', 'ocr-badge.pdf', 'ocr-colbreak.pdf', 'ocr-centered.pdf'];

describe('no-silent-loss: every engine-recognized word lands somewhere in the output', () => {
  for (const name of OCR_FIXTURES) {
    it(`${name}: no dumped word is missing from the markdown`, () => {
      const dump = debugWordsPath();
      const { md } = run([fixturePath(name), '--stdout', '--ocr', `--debug-words=${dump}`]);
      const words = readDebugWords(dump).map((w) => w.text);
      assert.ok(words.length > 0, `--debug-words produced no words for ${name} — engine or flag broken`);

      const haystack = normalize(md);
      const missing = [];
      for (const w of words) {
        const needle = normalize(w);
        if (!needle) continue; // pure punctuation token (e.g. a lone "-"), nothing to check
        if (!haystack.includes(needle)) missing.push(w);
      }
      assert.deepEqual(missing, [], `words recognized by the engine but missing from ${name}'s markdown output: ${JSON.stringify(missing)}`);
    });
  }
});
