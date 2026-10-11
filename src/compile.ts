// Thompson construction: a syntax tree becomes a flat instruction program.
//
// Every production emits a contiguous block of instructions and leaves control
// falling through to the next address, so no patch lists are needed beyond the
// forward jumps written back in place. Branch priority is encoded in the
// argument order of `split`, which is what gives leftmost-first semantics.

import type { Node } from "./ast.ts";
import { groupRange, matchesEmpty } from "./ast.ts";
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
    regCount: c.regCount,
    groupCount,
    source: pattern,
  };
}

class Compiler {
  readonly insts: Inst[] = [];
  readonly pattern: string;
  readonly limit: number;
  regCount = 0;

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

  /** One progress register per quantifier that can guard an empty iteration. */
  newReg(): number {
    return this.regCount++;
  }

  /**
   * Emits the per-iteration capture reset for a quantifier body, if it holds
   * any groups. Returns true when an instruction was emitted.
   */
  clearBodyGroups(body: Node): boolean {
    const range = groupRange(body);
    if (range === null) return false;
    this.emit({ op: "clear", from: 2 * range[0], to: 2 * range[1] + 1 });
    return true;
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

    // Counted repetition expands by duplicating the body: `min` mandatory
    // copies, then either a trailing star (open range) or `max - min` optional
    // copies. Every emit() call is checked against the size limit, so an
    // expansion that would explode is rejected instead of consuming memory.
    //
    // The first `min` iterations are allowed to match the empty string, which
    // is why they carry no progress guard; every iteration after that is one
    // the quantifier could legally skip, so it must consume input. That split
    // is the ECMAScript RepeatMatcher rule, and reproducing it is what keeps
    // the whole-match span in step with the platform engine on patterns such
    // as /(a?|.+){1,2}/.
    for (let i = 0; i < min; i++) {
      this.clearBodyGroups(body);
      this.node(body);
    }
    if (max === Infinity) {
      this.star(body);
      return;
    }
    const optionalCopies = max - min;
    const guarded = matchesEmpty(body);
    const reg = guarded ? this.newReg() : -1;
    const splits: number[] = [];
    for (let i = 0; i < optionalCopies; i++) {
      const split = this.emit({ op: "split", x: 0, y: 0 });
      splits.push(split);
      this.patchSplit(split, this.here, 0);
      if (guarded) this.emit({ op: "mark", reg });
      this.clearBodyGroups(body);
      this.node(body);
      if (guarded) this.emit({ op: "progress", reg });
    }
    for (const split of splits) this.patchSplit(split, undefined, this.here);
  }

  // A body that cannot match the empty string can never trigger the
  // ECMAScript empty-iteration rule, so the guard instructions are emitted
  // only where they can change the answer. That keeps /a+/ and /\d*/ at the
  // textbook three or four instructions and pays the extra cost just for the
  // patterns that need it.

  //  unguarded             guarded (body can match empty)
  //  L1: split L2, L3      L1: split L2, L5
  //  L2: body              L2: mark r
  //      jump L1           L3: body
  //  L3:                       progress r
  //                            jump L1
  //                        L5:
  star(body: Node): void {
    const guarded = matchesEmpty(body);
    const reg = guarded ? this.newReg() : -1;
    const top = this.emit({ op: "split", x: 0, y: 0 });
    this.patchSplit(top, this.here, 0);
    if (guarded) this.emit({ op: "mark", reg });
    this.clearBodyGroups(body);
    this.node(body);
    if (guarded) this.emit({ op: "progress", reg });
    this.emit({ op: "jump", x: top });
    this.patchSplit(top, undefined, this.here);
  }

  // When the body cannot match empty, one copy and a backward split is enough.
  //
  // When it can, the body is emitted twice: once unguarded for the first
  // iteration, which ECMAScript allows to match empty, and once inside a
  // guarded star for the rest. A single shared copy would not do, because the
  // sparse set admits each program counter only once per input position, so
  // "first iteration empty, second iteration consumes" would be unreachable
  // for /(a?|x)+/ on "xx". Two copies give the two iterations distinct program
  // counters and the platform engine's answer falls out.
  plus(body: Node): void {
    if (!matchesEmpty(body)) {
      const top = this.here;
      this.clearBodyGroups(body);
      this.node(body);
      const split = this.emit({ op: "split", x: top, y: 0 });
      this.patchSplit(split, undefined, this.here);
      return;
    }
    this.clearBodyGroups(body);
    this.node(body);
    this.star(body);
  }

  //      split L1, L2          split L1, L2
  //  L1: body              L1: mark r
  //  L2:                       body
  //                            progress r
  //                        L2:
  optional(body: Node): void {
    const guarded = matchesEmpty(body);
    const reg = guarded ? this.newReg() : -1;
    const split = this.emit({ op: "split", x: 0, y: 0 });
    this.patchSplit(split, this.here, 0);
    if (guarded) this.emit({ op: "mark", reg });
    this.clearBodyGroups(body);
    this.node(body);
    if (guarded) this.emit({ op: "progress", reg });
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
