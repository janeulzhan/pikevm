// Public surface of the engine.

export type { Node } from "./ast.ts";
export { RegexSyntaxError, matchesEmpty, countGroups, groupRange, walk } from "./ast.ts";
export { parse } from "./parser.ts";
export type { ClassSet } from "./charclass.ts";
export { classMatches, describeClass } from "./charclass.ts";
export type { Inst, Program } from "./program.ts";
export { ProgramTooLargeError, disassemble, formatInst } from "./program.ts";
export { compile, MAX_PROGRAM_SIZE } from "./compile.ts";
export { SparseSet } from "./sparse.ts";
export type { MatchResult, VmStats, RunOptions } from "./vm.ts";
export { Vm } from "./vm.ts";

import { compile } from "./compile.ts";
import type { Program } from "./program.ts";
import type { MatchResult, RunOptions, VmStats } from "./vm.ts";
import { Vm } from "./vm.ts";

/**
 * A compiled pattern. Construction parses and compiles once; `test` and `exec`
 * reuse the same preallocated thread lists, so repeated matching allocates
 * almost nothing beyond capture slot clones.
 */
export class Regex {
  readonly source: string;
  readonly program: Program;
  private readonly vm: Vm;

  constructor(pattern: string) {
    this.source = pattern;
    this.program = compile(pattern);
    this.vm = new Vm(this.program);
  }

  get groupCount(): number {
    return this.program.groupCount;
  }

  get stats(): VmStats {
    return this.vm.stats;
  }

  /** Program counters active at each input position, after a traced run. */
  get trace(): number[][] {
    return this.vm.trace;
  }

  test(input: string, startAt = 0): boolean {
    return this.vm.test(input, startAt);
  }

  exec(input: string, startAt = 0): MatchResult | null {
    return this.vm.exec(input, startAt);
  }

  run(input: string, options: RunOptions): Int32Array | null {
    return this.vm.run(input, options);
  }
}
