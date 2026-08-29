// tmp.ts — package-local test scratch root, resolved from the package root (not
// process.cwd()) so it's stable regardless of the directory tests are invoked from.
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const TMP_ROOT = path.join(here, '..', '..', '.tmp');

/** A fresh uniquely-suffixed directory under TMP_ROOT, for throwaway per-run scratch. */
export function scratchDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, prefix));
}
