// The NFA program executed by the Pike VM.
//
// Six opcodes come straight from Thompson's construction as presented by Pike
// and by Cox: char, class, split, jump, save, match. Three more are needed to
// match ECMAScript exactly, and none of them consumes input, so none of them
// affects the linearity argument: `assert` carries '^' and '$', `clear` resets
// the capture slots of groups inside a quantifier at the start of each
// iteration, and `fail` is the dead end an iteration reaches when it was
// allowed to be skipped and consumed nothing.

import type { ClassSet } from "./charclass.ts";
import { describeClass } from "./charclass.ts";

export type Inst =
  | { op: "char"; code: number; next?: number }
  | { op: "class"; set: ClassSet; next?: number }
  | { op: "split"; x: number; y: number } // x is the preferred branch
  | { op: "jump"; x: number }
  | { op: "save"; slot: number }
  | { op: "assert"; at: "bol" | "eol" }
  // Dead end. Reached when an iteration of a quantifier past its declared
  // minimum consumed nothing, which ECMAScript does not allow.
  | { op: "fail" }
  // Resets the capture slots of every group inside a quantifier at the start
  // of each iteration, which is the other ECMAScript rule a plain Pike VM does
  // not reproduce: /(?:(a)|b)+/ on "ab" leaves group one unset, because the
  // final iteration took the branch without it.
  | { op: "clear"; from: number; to: number }
  | { op: "match" };

export interface Program {
  readonly insts: readonly Inst[];
  /** Two slots per group, plus slots 0 and 1 for the whole match. */
  readonly slotCount: number;
  readonly groupCount: number;
  readonly source: string;
}

/** Raised when {m,n} expansion would produce an unreasonably large program. */
export class ProgramTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number, pattern: string) {
    super(
      `pattern /${pattern}/ expands past the ${limit} instruction limit; ` +
        `reduce the counted repetition bounds`,
    );
    this.name = "ProgramTooLargeError";
    this.limit = limit;
  }
}

export function disassemble(program: Program): string {
  const width = String(program.insts.length - 1).length;
  return program.insts
    .map((inst, pc) => `${String(pc).padStart(width, " ")}  ${formatInst(inst)}`)
    .join("\n");
}

function jumpTo(next: number | undefined): string {
  return next === undefined ? "" : ` -> ${next}`;
}

export function formatInst(inst: Inst): string {
  switch (inst.op) {
    case "char":
      return `char ${JSON.stringify(String.fromCharCode(inst.code))}${jumpTo(inst.next)}`;
    case "class":
      return `class ${describeClass(inst.set)}${jumpTo(inst.next)}`;
    case "split":
      return `split ${inst.x}, ${inst.y}`;
    case "jump":
      return `jump ${inst.x}`;
    case "save":
      return `save ${inst.slot}`;
    case "assert":
      return `assert ${inst.at === "bol" ? "^" : "$"}`;
    case "fail":
      return "fail";
    case "clear":
      return `clear ${inst.from}..${inst.to}`;
    case "match":
      return "match";
  }
}
