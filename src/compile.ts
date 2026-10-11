// Thompson construction: a syntax tree becomes a flat instruction program.
//
// Every production emits a contiguous block of instructions and leaves control
// falling through to the next address, so no patch lists are needed beyond the
// forward jumps written back in place. Branch priority is encoded in the
// argument order of `split`, which is what gives leftmost-first semantics.

import type { Node } from "./ast.ts";
import { parse } from "./parser.ts";
import type { Inst, Program } from "./program.ts";
import { ProgramTooLargeError } from "./program.ts";

/** Hard ceiling on program size. Guards against {m,n} expansion blowing up. */
export const MAX_PROGRAM_SIZE = 10000;

export function compile(pattern: string, limit = MAX_PROGRAM_SIZE): Program {
  const { ast, groupCount } = parse(pattern);
  const c = new Compiler(pattern, limit);
  c.emit({ op: "save", slot: 0 });
  c.node(ast);
  c.emit({ op: "save", slot: 1 });
  c.emit({ op: "match" });
  return {
    insts: c.insts,
    slotCount: 2 * (groupCount + 1),
    groupCount,
    source: pattern,
  };
}

class Compiler {
  readonly insts: Inst[] = [];
  readonly pattern: string;
  readonly limit: number;

  constructor(pattern: string, limit: number) {
    this.pattern = pattern;
    this.limit = limit;
  }

  emit(inst: Inst): number {
    if (this.insts.length >= this.limit) {
      throw new ProgramTooLargeError(this.limit, this.pattern);
    }
    this.insts.push(inst);
    return this.insts.length - 1;
  }

  get here(): number {
    return this.insts.length;
  }

  node(n: Node): void {
    switch (n.kind) {
      case "empty":
        return;
      case "char":
        this.emit({ op: "char", code: n.code });
        return;
      case "class":
        this.emit({ op: "class", set: n.set });
        return;
      case "assert":
        this.emit({ op: "assert", at: n.at });
        return;
      case "concat":
        for (const part of n.parts) this.node(part);
        return;
      case "alt":
        this.alt(n.options);
        return;
      case "group":
        this.emit({ op: "save", slot: 2 * n.index });
        this.node(n.body);
        this.emit({ op: "save", slot: 2 * n.index + 1 });
        return;
      case "noncap":
        this.node(n.body);
        return;
      case "repeat":
        this.repeat(n.body, n.min, n.max);
        return;
    }
  }

  // e1 | e2 | e3
  //     split L1, L2
  //  L1: e1
  //     jump End
  //  L2: split L3, L4   ... and so on
  alt(options: readonly Node[]): void {
    const jumpsToEnd: number[] = [];
    for (let i = 0; i < options.length; i++) {
      const last = i === options.length - 1;
      if (last) {
        this.node(options[i]);
        break;
      }
      const split = this.emit({ op: "split", x: 0, y: 0 });
      this.patchSplit(split, this.here, 0);
      this.node(options[i]);
      jumpsToEnd.push(this.emit({ op: "jump", x: 0 }));
      this.patchSplit(split, undefined, this.here);
    }
    for (const j of jumpsToEnd) this.patchJump(j, this.here);
  }

  repeat(body: Node, min: number, max: number): void {
    if (max === 0) return; // {0} and {0,0} contribute nothing
    if (min === 0 && max === Infinity) return this.star(body);
    if (min === 1 && max === Infinity) return this.plus(body);
    if (min === 0 && max === 1) return this.optional(body);

    // Counted repetition expands by duplicating the subtree: `min` mandatory
    // copies, then either a trailing star (open range) or `max - min` nested
    // optional copies. Every emit() call is checked against the size limit, so
    // an expansion that would explode is rejected rather than consuming memory.
    for (let i = 0; i < min; i++) this.node(body);
    if (max === Infinity) {
      // a{2,} is a a a*
      this.star(body);
      return;
    }
    const optionalCopies = max - min;
    // Nested so that a{1,3} accepts 1, 2 or 3 copies and prefers more of them.
    const splits: number[] = [];
    for (let i = 0; i < optionalCopies; i++) {
      const split = this.emit({ op: "split", x: 0, y: 0 });
      splits.push(split);
      this.patchSplit(split, this.here, 0);
      this.node(body);
    }
    for (const split of splits) this.patchSplit(split, undefined, this.here);
  }

  //  L1: split L2, L3
  //  L2: body
  //      jump L1
  //  L3:
  star(body: Node): void {
    const top = this.emit({ op: "split", x: 0, y: 0 });
    this.patchSplit(top, this.here, 0);
    this.node(body);
    this.emit({ op: "jump", x: top });
    this.patchSplit(top, undefined, this.here);
  }

  //  L1: body
  //      split L1, L2
  //  L2:
  plus(body: Node): void {
    const top = this.here;
    this.node(body);
    const split = this.emit({ op: "split", x: top, y: 0 });
    this.patchSplit(split, undefined, this.here);
  }

  //      split L1, L2
  //  L1: body
  //  L2:
  optional(body: Node): void {
    const split = this.emit({ op: "split", x: 0, y: 0 });
    this.patchSplit(split, this.here, 0);
    this.node(body);
    this.patchSplit(split, undefined, this.here);
  }

  patchSplit(pc: number, x: number | undefined, y: number | undefined): void {
    const inst = this.insts[pc];
    if (inst.op !== "split") throw new Error(`instruction ${pc} is not a split`);
    if (x !== undefined) inst.x = x;
    if (y !== undefined) inst.y = y;
  }

  patchJump(pc: number, target: number): void {
    const inst = this.insts[pc];
    if (inst.op !== "jump") throw new Error(`instruction ${pc} is not a jump`);
    inst.x = target;
  }
}
