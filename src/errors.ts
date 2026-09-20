// Library code throws; only src/cli.ts prints and exits.

/** The closed set of error codes every `PdfToMdError` carries — switch on
 * `code` instead of parsing `message`. */
export type PdfToMdErrorCode =
  /** input missing/unreadable/not a PDF */
  | 'PDF_OPEN'
  /** malformed page selection (validated before any work) */
  | 'PAGE_RANGE'
  /** rendering an opened, in-range page to PNG failed */
  | 'PAGE_RENDER'
  /** the OCR engine crashed twice on one page (message names it) */
  | 'OCR_PAGE_FAILED'
  /** malformed word-dump input (--words-json / extractOcr words) */
  | 'WORDS_INPUT'
  /** malformed or insufficient evidence passed to auditWords */
  | 'AUDIT_INPUT'
  /** malformed Analysis handed to toMarkdown/toText (e.g. an out-of-range
   * wordIndexes entry) — validated fail-fast, whole object checked before any output. */
  | 'ANALYSIS_INPUT';

/** The error every entry point throws — never a bare `Error`. */
export class PdfToMdError extends Error {
  code: PdfToMdErrorCode;

  constructor(code: PdfToMdErrorCode, message: string) {
    super(message);
    this.name = 'PdfToMdError';
    this.code = code;
  }
}
