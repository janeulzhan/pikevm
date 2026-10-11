// The Pike VM: a simulation of the Thompson NFA that advances every live
// thread in lockstep through a single left to right pass over the input.
//
// The one idea that matters is the membership guard at the top of addThread.
// Each input position gets a fresh sparse set, and a program counter may enter
// that set only once. So a position holds at most `program.length` threads, the
// whole run performs at most (inputLength + 1) * program.length units of work,
// and a pattern such as /(a*)*b/ cannot spin on its empty body because the
// second visit to the loop head is refused. Linear time and termination on
// empty loops are the same guarantee, not two.

import { classMatches } from "./charclass.ts";
import type { Inst, Program } from "./program.ts";
import { SparseSet } from "./sparse.ts";

export interface VmStats {
  /** Program counters actually admitted to a thread list. The linear bound. */
  addsPerformed: number;
  /** Calls into addThread, including the ones the membership guard rejects. */
  addCalls: number;
  /** Runnable threads examined by the stepping loop. */
  charSteps: number;
  /** Largest runnable thread list seen, never more than program.length. */
  maxListSize: number;
  /** Input positions visited. */
  positions: number;
  /** Capture slot arrays cloned by copy-on-write. */
  capClones: number;
}

export interface MatchResult {
  readonly index: number;
  readonly end: number;
  /** Spans by group number, index 0 being the whole match. */
  readonly groups: readonly (readonly [number, number] | null)[];
  readonly slices: readonly (string | null)[];
}

export interface RunOptions {
  /** Track capture slots. Turning this off makes test() measurably faster. */
  readonly captures?: boolean;
  readonly startAt?: number;
  /** Record the active program counters at every input position. */
  readonly trace?: boolean;
}

class ThreadList {
  readonly visited: SparseSet;
  readonly pcs: Int32Array;
  readonly caps: (Int32Array | null)[];
  size = 0;

  constructor(progLen: number) {
    this.visited = new SparseSet(progLen);
    this.pcs = new Int32Array(progLen);
    this.caps = new Array(progLen).fill(null);
  }

  begin(): void {
    this.visited.clear();
    this.size = 0;
  }
}

export class Vm {
  readonly program: Program;
  private readonly listA: ThreadList;
  private readonly listB: ThreadList;
  private readonly stackPc: Int32Array;
  private readonly stackCaps: (Int32Array | null)[];
  private readonly emptyCaps: Int32Array;
  stats: VmStats = freshStats();
  /** Populated only when the trace option is set. */
  trace: number[][] = [];

  constructor(program: Program) {
    this.program = program;
    const len = program.insts.length;
    this.listA = new ThreadList(len);
    this.listB = new ThreadList(len);
    this.stackPc = new Int32Array(2 * len + 8);
    this.stackCaps = new Array(2 * len + 8).fill(null);
    this.emptyCaps = new Int32Array(program.slotCount).fill(-1);
  }

  test(input: string, startAt = 0): boolean {
    return this.run(input, { captures: false, startAt }) !== null;
  }

  exec(input: string, startAt = 0): MatchResult | null {
    const slots = this.run(input, { captures: true, startAt });
    if (slots === null) return null;
    return buildResult(input, slots, this.program.groupCount);
  }

  /** Returns the winning capture slots, or null when nothing matched. */
  run(input: string, options: RunOptions = {}): Int32Array | null {
    const captures = options.captures !== false;
    const startAt = options.startAt ?? 0;
    const tracing = options.trace === true;
    const insts = this.program.insts;
    const n = input.length;

    this.stats = freshStats();
    if (tracing) this.trace = [];

    let clist = this.listA;
    let nlist = this.listB;
    let matched: Int32Array | null = null;

    clist.begin();
    this.addThread(clist, 0, startAt, this.emptyCaps, input, captures);

    for (let pos = startAt; ; pos++) {
      this.stats.positions += 1;
      if (clist.size > this.stats.maxListSize) this.stats.maxListSize = clist.size;
      if (tracing) this.trace.push(clist.visited.values());

      const ch = pos < n ? input.charCodeAt(pos) : -1;
      nlist.begin();

      for (let i = 0; i < clist.size; i++) {
        this.stats.charSteps += 1;
        const pc = clist.pcs[i];
        const caps = clist.caps[i] as Int32Array;
        const inst = insts[pc];
        if (inst.op === "char") {
          if (ch === inst.code) {
            // `next` is set only inside a guarded quantifier body, where
            // consuming a character moves the thread into the copy of the body
            // that is allowed to end the iteration.
            const to = inst.next === undefined ? pc + 1 : inst.next;
            this.addThread(nlist, to, pos + 1, caps, input, captures);
          }
        } else if (inst.op === "class") {
          if (ch >= 0 && classMatches(inst.set, ch)) {
            const to = inst.next === undefined ? pc + 1 : inst.next;
            this.addThread(nlist, to, pos + 1, caps, input, captures);
          }
        } else {
          // `match`. Record it and cut every lower priority thread still in
          // this list: that cut is what makes the semantics leftmost-first.
          matched = caps;
          break;
        }
      }

      if (pos >= n) break;
      // A fresh start position joins at the lowest priority, so an earlier
      // starting match always wins. Once something has matched, stop seeding.
      if (matched === null) {
        this.addThread(nlist, 0, pos + 1, this.emptyCaps, input, captures);
      }
      const swap = clist;
      clist = nlist;
      nlist = swap;
      if (clist.size === 0 && matched !== null) break;
    }

    return matched;
  }

  /**
   * Follows the epsilon closure from `pc` and files every instruction that
   * waits on input into `list`. Iterative with an explicit stack, so a ten
   * thousand instruction program cannot overflow the JavaScript call stack.
   * Pushing the y branch before the x branch makes the LIFO order equal to a
   * depth first walk that prefers x, which is the compiled branch priority.
   */
  private addThread(
    list: ThreadList,
    pc0: number,
    pos: number,
    caps0: Int32Array,
    input: string,
    captures: boolean,
  ): void {
    this.stats.addCalls += 1;
    const insts = this.program.insts;
    const stackPc = this.stackPc;
    const stackCaps = this.stackCaps;
    let sp = 0;
    stackPc[sp] = pc0;
    stackCaps[sp] = caps0;
    sp += 1;

    while (sp > 0) {
      sp -= 1;
      const pc = stackPc[sp];
      const caps = stackCaps[sp] as Int32Array;
      // The membership guard, checked before any expansion. One visit per
      // program counter per input position: that is the whole linearity
      // argument, and it is also why an empty loop body terminates.
      if (!list.visited.add(pc)) continue;
      this.stats.addsPerformed += 1;

      const inst: Inst = insts[pc];
      switch (inst.op) {
        case "jump":
          sp = this.push(stackPc, stackCaps, sp, inst.x, caps);
          break;
        case "split":
          sp = this.push(stackPc, stackCaps, sp, inst.y, caps);
          sp = this.push(stackPc, stackCaps, sp, inst.x, caps);
          break;
        case "save": {
          let next = caps;
          if (captures && caps[inst.slot] !== pos) {
            next = caps.slice();
            next[inst.slot] = pos;
            this.stats.capClones += 1;
          }
          sp = this.push(stackPc, stackCaps, sp, pc + 1, next);
          break;
        }
        case "assert": {
          const holds = inst.at === "bol" ? pos === 0 : pos === input.length;
          if (holds) sp = this.push(stackPc, stackCaps, sp, pc + 1, caps);
          break;
        }
        case "clear": {
          let next = caps;
          if (captures) {
            for (let slot = inst.from; slot <= inst.to; slot++) {
              if (caps[slot] === -1) continue;
              if (next === caps) next = caps.slice();
              next[slot] = -1;
            }
            if (next !== caps) this.stats.capClones += 1;
          }
          sp = this.push(stackPc, stackCaps, sp, pc + 1, next);
          break;
        }
        case "fail":
          // An iteration of a skippable quantifier that consumed nothing.
          break;
        default:
          // char, class and match all wait here until the stepping loop runs.
          list.pcs[list.size] = pc;
          list.caps[list.size] = caps;
          list.size += 1;
          break;
      }
    }
  }

  private push(
    stackPc: Int32Array,
    stackCaps: (Int32Array | null)[],
    sp: number,
    pc: number,
    caps: Int32Array,
  ): number {
    if (sp >= stackPc.length) {
      throw new Error("epsilon closure stack overflow: this is an engine bug");
    }
    stackPc[sp] = pc;
    stackCaps[sp] = caps;
    return sp + 1;
  }
}

function freshStats(): VmStats {
  return {
    addsPerformed: 0,
    addCalls: 0,
    charSteps: 0,
    maxListSize: 0,
    positions: 0,
    capClones: 0,
  };
}

function buildResult(
  input: string,
  slots: Int32Array,
  groupCount: number,
): MatchResult {
  const groups: (readonly [number, number] | null)[] = [];
  const slices: (string | null)[] = [];
  for (let g = 0; g <= groupCount; g++) {
    const start = slots[2 * g];
    const end = slots[2 * g + 1];
    if (start < 0 || end < 0) {
      groups.push(null);
      slices.push(null);
    } else {
      groups.push([start, end]);
      slices.push(input.slice(start, end));
    }
  }
  return {
    index: slots[0],
    end: slots[1],
    groups,
    slices,
  };
}
