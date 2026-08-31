// audit command — the severity-1 audit instrument (README's "Design
// contract") as a first-class subcommand. Thin wrapper over src/audit.ts's auditWords (the library returns data, only the CLI prints and exits).
import { auditWords } from '../audit.ts';
import type { Command } from './types.ts';

const USAGE = 'usage: pdf-to-md audit <words.jsonl> <file.md>';

const audit: Command = async (ctx) => {
  if (ctx.rest.includes('-h') || ctx.rest.includes('--help')) {
    console.log(USAGE);
    return;
  }
  const [wordsPath, mdPath] = ctx.rest;
  if (!wordsPath || !mdPath) ctx.usageError(USAGE);

  const result = auditWords(wordsPath, mdPath);
  for (const line of result.lines) console.log(line);

  // MISSING>0 is the severity-1 fail signal: a recognized word this markdown
  // lost. Exit with the CLI's error code so the subcommand is usable as a CI gate; strict_deficits from hyphen-join repairs are reported but not failures.
  if (result.missing > 0) process.exitCode = ctx.errorCode;
};

export default audit;
