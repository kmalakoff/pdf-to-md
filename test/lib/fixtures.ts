// fixtures.ts — builds and caches the suite's 12 synthetic PDFs (no binary
// fixture is committed). mocha runs one serial process, but concurrent test invocations can race on a cold cache, so generation is guarded by an atomic mkdir lock; the loser polls for the "done" marker.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const generatorPath = path.join(here, 'make-fixtures.ts');

// Keyed by a hash of the generator source (not a fixed name), so editing
// make-fixtures.ts invalidates the cache instead of testing stale PDFs.
function sourceTag(): string {
  const src = readFileSync(generatorPath, 'utf8');
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (Math.imul(h, 31) + src.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const FIXTURE_NAMES = ['text-single.pdf', 'text-twocol.pdf', 'text-twopage.pdf', 'text-hybrid.pdf', 'ocr-single.pdf', 'ocr-twocol.pdf', 'ocr-badge.pdf', 'ocr-centered.pdf', 'ocr-colbreak.pdf', 'ocr-book.pdf', 'ocr-chart.pdf', 'ocr-chart-only.pdf'];

let cachedDir: string | null = null;

export function fixturesDir(): string {
  if (cachedDir) return cachedDir;

  const dir = path.join(os.tmpdir(), `pdf-to-md-fixtures-${sourceTag()}`);
  const marker = path.join(dir, '.done');
  const lock = `${dir}.lock`;

  if (existsSync(marker)) {
    cachedDir = dir;
    return dir;
  }

  let haveLock = false;
  try {
    mkdirSync(lock);
    haveLock = true;
  } catch {
    // another process is already generating; poll for the marker
  }

  if (haveLock) {
    try {
      mkdirSync(dir, { recursive: true });
      // Same Node binary running this test file — native TS execution, no
      // build step (only src/ compiles; see bin/cli.js's own header for the shim).
      execFileSync(process.execPath, [generatorPath, dir], { stdio: 'pipe' });
      for (const name of FIXTURE_NAMES) {
        if (!existsSync(path.join(dir, name))) throw new Error(`make-fixtures.ts did not produce ${name}`);
      }
      writeFileSync(marker, new Date().toISOString());
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  } else {
    const deadline = Date.now() + 60_000;
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error('timed out waiting for fixture generation by another test worker');
      // Synchronous 200ms sleep without a child process — spawning `sleep` is POSIX-only (ENOENT on Windows).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }

  cachedDir = dir;
  return dir;
}

export function fixturePath(name: string): string {
  return path.join(fixturesDir(), name);
}
