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
  //      split L1, L2
  //  L1: e1
  //      jump End
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
    // The first `min` iterations are allowed to match the empty string, so
    // they are emitted unguarded; every iteration after that is one the
    // quantifier could legally skip, so it must consume input. That split is
    // the ECMAScript RepeatMatcher rule, and reproducing it is what keeps the
    // whole-match span in step with the platform engine on patterns such as
    // /(a?|.+){1,2}/.
    for (let i = 0; i < min; i++) this.iteration(body, false);
    if (max === Infinity) {
      // a{2,} is a a a*
      this.star(body);
      return;
    }
    const optionalCopies = max - min;
    const guarded = matchesEmpty(body);
    const splits: number[] = [];
    for (let i = 0; i < optionalCopies; i++) {
      const split = this.emit({ op: "split", x: 0, y: 0 });
      splits.push(split);
      this.patchSplit(split, this.here, 0);
      this.iteration(body, guarded);
    }
    for (const split of splits) this.patchSplit(split, undefined, this.here);
  }

  /**
   * Emits the per-iteration capture reset for a quantifier body, if it holds
   * any groups. ECMAScript clears the slots of every group inside a quantifier
   * at the start of each iteration, which is why /(?:(a)|b)+/ on "ab" leaves
   * group one unset rather than holding the "a" from the first iteration.
   */
  clearBodyGroups(body: Node): void {
    const range = groupRange(body);
    if (range === null) return;
    this.emit({ op: "clear", from: 2 * range[0], to: 2 * range[1] + 1 });
  }

  /**
   * Emits one iteration of a quantifier that is allowed to be skipped, for a
   * body that can match the empty string.
   *
   * ECMAScript requires such an iteration to consume input: /(a?)* / on "" sets
   * no capture, because the single empty iteration is rejected and the loop
   * runs zero times. Expressing that with a register, "remember where this
   * iteration started and die if it ends there", is the obvious move and it is
   * wrong in a thread-deduplicating VM: two threads can reach the same program
   * counter at the same position holding different register values, and the
   * sparse set keeps only one of them. That loses real matches, at a rate of
   * about six in a million generated pairs, which is exactly the sort of thing
   * a differential fuzz finds and inspection does not.
   *
   * So the state goes in the program counter instead, as a product with a one
   * bit "has this iteration consumed anything yet" flag. The body is emitted
   * twice:
   *
   *     clear               capture slots of groups inside the body
   *     <copy N>            nothing consumed yet; every char and class in here
   *                         transfers into the matching place in copy C
   *     fail                fell out of copy N, so the iteration was empty
   *     <copy C>            something has been consumed; falls out normally
   *
   * Both copies have the same shape, so instruction i of copy N corresponds to
   * instruction i of copy C and the transfer is a fixed offset. Every thread
   * reaching a given program counter now has the same future, dedup is sound
   * again, and the register disappears.
   */
  guardedBody(body: Node): void {
    this.clearBodyGroups(body);
    const nothingConsumed = this.here;
    this.node(body);
    const length = this.here - nothingConsumed;
    this.emit({ op: "fail" });
    const consumed = this.here;
    this.node(body);
    if (this.here - consumed !== length) {
      throw new Error("the two copies of a guarded quantifier body differ in length");
    }
    // Redirect every consuming instruction in copy N to its counterpart in
    // copy C. A nested guarded quantifier inside the body has already set its
    // own `next`, pointing somewhere else inside copy N, so the two mappings
    // compose: take wherever the thread would have gone, and shift it into
    // copy C.
    const delta = consumed - nothingConsumed;
    for (let i = 0; i < length; i++) {
      const inst = this.insts[nothingConsumed + i];
      if (inst.op === "char" || inst.op === "class") {
        const target = inst.next === undefined ? nothingConsumed + i + 1 : inst.next;
        inst.next = target + delta;
      }
    }
  }

  /** One iteration of a quantifier, guarded only where the body needs it. */
  iteration(body: Node, guarded: boolean): void {
    if (guarded) {
      this.guardedBody(body);
      return;
    }
    this.clearBodyGroups(body);
    this.node(body);
  }

  //  L1: split L2, L3
  //  L2: one iteration
  //      jump L1
  //  L3:
  star(body: Node): void {
    const guarded = matchesEmpty(body);
    const top = this.emit({ op: "split", x: 0, y: 0 });
    this.patchSplit(top, this.here, 0);
    this.iteration(body, guarded);
    this.emit({ op: "jump", x: top });
    this.patchSplit(top, undefined, this.here);
  }

  // A body that cannot match empty needs no guard at all, so /a+/ stays at the
  // textbook three instructions. A body that can is emitted once unguarded,
  // because ECMAScript lets the first iteration of a '+' match empty, and then
  // again inside a guarded star for every iteration after that.
  plus(body: Node): void {
    if (!matchesEmpty(body)) {
      const top = this.here;
      this.clearBodyGroups(body);
      this.node(body);
      const split = this.emit({ op: "split", x: top, y: 0 });
      this.patchSplit(split, undefined, this.here);
      return;
    }
    this.iteration(body, false);
    this.star(body);
  }

  //      split L1, L2
  //  L1: one iteration
  //  L2:
  optional(body: Node): void {
    const guarded = matchesEmpty(body);
    const split = this.emit({ op: "split", x: 0, y: 0 });
    this.patchSplit(split, this.here, 0);
    this.iteration(body, guarded);
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
