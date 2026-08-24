// run.ts — execs bin/cli.js the way a caller does, and parses its output.
// bin/cli.js delegates into dist/esm or dist/cjs, so a prior build is required — the "pretest" npm script handles that.
import assert from 'node:assert/strict';
import { type SpawnSyncOptions, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cr from 'cr';
import type { Report } from '../../src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const cliPath = path.join(here, '..', '..', 'bin', 'cli.js');

// Report is one shape for both paths (discriminated by `path: 'text' | 'ocr'`),
// so tests read any field directly with no per-test type guard; aliased here so call sites don't need to import src/types.ts.
export type AnyReport = Report;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  md: string;
  report: AnyReport | null;
}

/**
 * Run the CLI against a fixture and capture both streams.
 *
 *   run(['fixture.pdf', '--stdout', '--ocr', '--json'])
 *
 * @returns md - stdout with any trailing --json report stripped off
 * @returns report - the parsed --json report, or null if absent/unparsable
 */
export function run(args: string[], opts: SpawnSyncOptions = {}): RunResult {
  // spawnSync, not execFileSync: stderr must be captured even on a clean exit (e.g. the auto-OCR fallback notice).
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  // cr(): normalize any Windows CRLF so line-based parsing below (and every caller's assertion) sees LF.
  const stdout = cr(result.stdout?.toString() ?? '');
  const stderr = cr(result.stderr?.toString() ?? '');

  let report: AnyReport | null = null;
  let md = stdout;
  if (args.includes('--json')) {
    // report is JSON.stringify(report, null, 1) -> starts with "{\n"; with
    // --stdout also set, markdown (ending in its own "\n") precedes it on the same stream.
    const jsonStart = stdout.indexOf('{\n');
    if (jsonStart >= 0) {
      md = stdout.slice(0, jsonStart);
      try {
        report = JSON.parse(stdout.slice(jsonStart));
      } catch {
        report = null;
      }
    }
  }
  return { status: result.status, stdout, stderr, md, report };
}

/**
 * Assert the CLI produced a report, failing with the reason it did not.
 *
 * A bare `assert.ok(report)` throws away the CLI's exit status and stderr —
 * which is the entire diagnosis. A Windows-only failure of exactly this shape
 * reported nothing but "expected a parsed JSON report" for a whole CI cycle,
 * with the actual error sitting unread on the CLI's stderr.
 */
export function expectReport(result: RunResult): AnyReport {
  assert.ok(result.report, `expected a parsed JSON report, got none — CLI exited ${result.status}\nstderr: ${result.stderr.trim() || '(empty)'}\nstdout (first 400 chars): ${JSON.stringify(result.stdout.slice(0, 400))}`);
  return result.report;
}
