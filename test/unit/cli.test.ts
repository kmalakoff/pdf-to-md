// cli.test.ts — the top-level dispatcher (src/cli.ts): --version/-v, --help/-h, the no-args
// usage-error path, an unknown flag, and the render fail-fast pre-open range check.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixturePath } from '../lib/fixtures.ts';
import { run } from '../lib/run.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')) as { version: string };
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

describe('cli: --version / -v', () => {
  for (const flag of ['--version', '-v']) {
    it(`${flag} exits 0 and prints package.json's version`, () => {
      const { status, stdout } = run([flag]);
      assert.equal(status, 0);
      const version = stdout.trim();
      assert.match(version, SEMVER);
      assert.equal(version, pkg.version);
    });
  }
});

describe('cli: --help / -h', () => {
  for (const flag of ['--help', '-h']) {
    it(`${flag} exits 0, banners "pdf-to-md v<version>", then the usage text`, () => {
      const { status, stdout } = run([flag]);
      assert.equal(status, 0);
      assert.match(stdout, new RegExp(`^pdf-to-md v${pkg.version.replace(/\./g, '\\.')}\\n`));
      assert.match(stdout, /usage: pdf-to-md/);
    });
  }
});

describe('cli: no args', () => {
  it('exits 2, usage on stderr, no version banner', () => {
    const { status, stdout, stderr } = run([]);
    assert.equal(status, 2);
    assert.match(stderr, /usage: pdf-to-md/);
    assert.doesNotMatch(stderr, /^pdf-to-md v/);
    assert.equal(stdout, '');
  });
});

describe('cli: unknown flag', () => {
  it('extract --nope exits 2 with usage', () => {
    const { status, stderr } = run([fixturePath('text-single.pdf'), '--nope']);
    assert.equal(status, 2);
    assert.match(stderr, /usage:/i);
  });
});

describe('cli: render fail-fast pre-open range check', () => {
  it('a reversed range (5-2) is a usage error, not a runtime one', () => {
    const { status, stderr } = run(['render', fixturePath('text-single.pdf'), '5-2']);
    assert.equal(status, 2);
    assert.match(stderr, /usage:/i);
    assert.match(stderr, /invalid page spec/i);
  });
});
