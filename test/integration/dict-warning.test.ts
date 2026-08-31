// dict-warning.test.ts — the dictionary-unavailable notice (src/dict.ts), delivered through
// extractText/extractOcr's warn() channel (src/extract.ts), never console.error.

// Forces the no-dictionary case via test/lib/dict-warning-runner.ts, a child process with
// PDF_TO_MD_DICT_PATH pointed at a nonexistent path — the bundled dictionary is otherwise always present.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixturePath } from '../lib/fixtures.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.join(here, '..', 'lib', 'dict-warning-runner.ts');
const NO_DICT_PATH = '/nonexistent/pdf-to-md-test-dict-words';

function runWithNoDict(mode: 'text' | 'ocr' | 'analyze-text' | 'analyze-ocr', fixture: string): { markdown: string; warnings: string[] } {
  // the flag is required at the 22.13 floor and a no-op where type stripping is default
  const out = execFileSync(process.execPath, ['--experimental-strip-types', runnerPath, mode, fixturePath(fixture)], {
    encoding: 'utf8',
    env: { ...process.env, PDF_TO_MD_DICT_PATH: NO_DICT_PATH },
  });
  return JSON.parse(out);
}

describe('dictionary-unavailable warning (PDF_TO_MD_DICT_PATH override)', () => {
  it('extractText warns and keeps the line-final hyphen unresolved', () => {
    const { markdown, warnings } = runWithNoDict('text', 'text-single.pdf');
    assert.ok(
      warnings.some((w) => w.includes(NO_DICT_PATH) && /line-final hyphens kept unresolved/.test(w)),
      `expected a dictionary-unavailable warning, got ${JSON.stringify(warnings)}`
    );
    assert.match(markdown, /creat-\s*ive/);
  });

  it('extractOcr warns and keeps the line-final hyphen unresolved', () => {
    const { markdown, warnings } = runWithNoDict('ocr', 'ocr-single.pdf');
    assert.ok(
      warnings.some((w) => w.includes(NO_DICT_PATH) && /line-final hyphens kept unresolved/.test(w)),
      `expected a dictionary-unavailable warning, got ${JSON.stringify(warnings)}`
    );
    assert.match(markdown, /creat-\s*ive/i);
  });

  it('analyze() warns on both paths via onWarning, same as the extract entry points', () => {
    for (const mode of ['analyze-text', 'analyze-ocr'] as const) {
      const { warnings } = runWithNoDict(mode, mode === 'analyze-ocr' ? 'ocr-single.pdf' : 'text-single.pdf');
      assert.ok(
        warnings.some((w) => w.includes(NO_DICT_PATH) && /line-final hyphens kept unresolved/.test(w)),
        `${mode}: expected a dictionary-unavailable warning, got ${JSON.stringify(warnings)}`
      );
    }
  });
});
