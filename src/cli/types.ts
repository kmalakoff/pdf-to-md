// Handed to every command; the command word is peeled off in src/cli.ts and
// each command owns its own parseArgs table over `rest` (our commands' flags are disjoint, so a shared table would let `render --para-gap=2` parse silently as a no-op).
export interface Ctx {
  /** binary name, for usage strings */
  name: string;
  /** argv after the command word */
  rest: string[];
  /** the CLI's fixed non-zero exit code, for result signals like audit loss */
  readonly errorCode: number;
  /** print the message and exit with the CLI's error code, on every malformed-invocation path.
   * Readonly property (not method) syntax: TS only applies never-return control-flow analysis to readonly property-typed function members. */
  readonly usageError: (message: string) => never;
}

export type Command = (ctx: Ctx) => Promise<void> | void;
