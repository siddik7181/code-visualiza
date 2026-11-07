// The part of Sval's API tracer.js uses (the package's own types are spread over many files).
export default class Sval {
  constructor(options?: { ecmaVer?: number | "latest"; sandBox?: boolean; sourceType?: "script" | "module" });
  /** Adds names to the interpreter's global scope. */
  import(names: Record<string, unknown>): void;
  /** The ESTree syntax tree (acorn's), with start/end offsets. */
  parse(code: string): any;
  /** Runs code, or a syntax tree from parse(). */
  run(code: string | object): void;
}
