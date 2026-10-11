// Abstract syntax tree for the supported regular expression grammar.
//
//   alt     := concat ('|' concat)*
//   concat  := rep*
//   rep     := atom ('*' | '+' | '?' | '{m}' | '{m,}' | '{m,n}')?
//   atom    := '(' alt ')' | '(?:' alt ')' | '[' class ']' | '.'
//            | '^' | '$' | literal | escape
//
// Deliberately absent: backreferences and lookaround. Both of them force a
// backtracking matcher, so leaving them out is what makes a single linear pass
// possible. See the limitations section of the README.

import type { ClassSet } from "./charclass.ts";

export type Node =
  | { kind: "empty" }
  | { kind: "char"; code: number }
  | { kind: "class"; set: ClassSet }
  | { kind: "assert"; at: "bol" | "eol" }
  | { kind: "concat"; parts: Node[] }
  | { kind: "alt"; options: Node[] }
  | { kind: "repeat"; body: Node; min: number; max: number } // max = Infinity for open ranges
  | { kind: "group"; body: Node; index: number } // capturing, 1-based
  | { kind: "noncap"; body: Node };

/** Thrown for any pattern outside the supported grammar. */
export class RegexSyntaxError extends Error {
  readonly offset: number;
  readonly pattern: string;
  constructor(message: string, pattern: string, offset: number) {
    super(`${message} (at offset ${offset} in /${pattern}/)`);
    this.name = "RegexSyntaxError";
    this.offset = offset;
    this.pattern = pattern;
  }
}

/** Walks every node in the tree, parents before children. */
export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  switch (node.kind) {
    case "concat":
      for (const p of node.parts) walk(p, visit);
      break;
    case "alt":
      for (const o of node.options) walk(o, visit);
      break;
    case "repeat":
      walk(node.body, visit);
      break;
    case "group":
    case "noncap":
      walk(node.body, visit);
      break;
    default:
      break;
  }
}

/** True when the node can match the empty string. */
export function matchesEmpty(node: Node): boolean {
  switch (node.kind) {
    case "empty":
    case "assert":
      return true;
    case "char":
    case "class":
      return false;
    case "concat":
      return node.parts.every(matchesEmpty);
    case "alt":
      return node.options.some(matchesEmpty);
    case "repeat":
      return node.min === 0 || matchesEmpty(node.body);
    case "group":
    case "noncap":
      return matchesEmpty(node.body);
  }
}

/** Number of capture groups in the tree. */
export function countGroups(node: Node): number {
  let n = 0;
  walk(node, (x) => {
    if (x.kind === "group") n += 1;
  });
  return n;
}
