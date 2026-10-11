// The NFA program executed by the Pike VM.
//
// Six core opcodes come straight from Thompson's construction as presented by
// Pike and by Cox: Char, Class, Split, Jump, Save, Match. One extra zero-width
// opcode, Assert, carries '^' and '$'; it consumes no input and so does not
// affect any of the linearity arguments.

import type { ClassSet } from "./charclass.ts";
import { describeClass } from "./charclass.ts";

export type Inst =
  | { op: "char"; code: number }
  | { op: "class"; set: ClassSet }
  | { op: "split"; x: number; y: number } // x is the preferred branch
  | { op: "jump"; x: number }
  | { op: "save"; slot: number }
  | { op: "assert"; at: "bol" | "eol" }
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

export function formatInst(inst: Inst): string {
  switch (inst.op) {
    case "char":
      return `char ${JSON.stringify(String.fromCharCode(inst.code))}`;
    case "class":
      return `class ${describeClass(inst.set)}`;
    case "split":
      return `split ${inst.x}, ${inst.y}`;
    case "jump":
      return `jump ${inst.x}`;
    case "save":
      return `save ${inst.slot}`;
    case "assert":
      return `assert ${inst.at === "bol" ? "^" : "$"}`;
    case "match":
      return "match";
  }
}
