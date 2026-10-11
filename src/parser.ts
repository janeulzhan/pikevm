// Recursive-descent parser. One function per grammar production, no tables, no
// regular expressions used anywhere in the implementation.

import type { Node } from "./ast.ts";
import { RegexSyntaxError } from "./ast.ts";
import type { ClassSet, Range } from "./charclass.ts";
import { DOT, SHORTHAND, makeClass } from "./charclass.ts";

/** Upper bound on a single {m,n} bound. The real guard is the program size cap. */
export const MAX_REPEAT = 100000;

const ESCAPED_LITERALS: Record<string, number> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  f: 0x0c,
  v: 0x0b,
  0: 0x00,
};

const METACHARS = "\\^$.|?*+()[]{}/-";

export interface ParseResult {
  readonly ast: Node;
  readonly groupCount: number;
}

export function parse(pattern: string): ParseResult {
  const p = new Parser(pattern);
  const ast = p.parseAlt();
  if (!p.atEnd()) {
    p.fail(`unexpected '${p.peek()}'`);
  }
  return { ast, groupCount: p.groupCount };
}

class Parser {
  readonly src: string;
  pos = 0;
  groupCount = 0;

  constructor(src: string) {
    this.src = src;
  }

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  peek(offset = 0): string {
    return this.src[this.pos + offset] ?? "";
  }

  next(): string {
    return this.src[this.pos++] ?? "";
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  expect(ch: string, what: string): void {
    if (!this.eat(ch)) this.fail(`expected '${ch}' ${what}`);
  }

  fail(message: string): never {
    throw new RegexSyntaxError(message, this.src, this.pos);
  }

  // alt := concat ('|' concat)*
  parseAlt(): Node {
    const options: Node[] = [this.parseConcat()];
    while (this.eat("|")) options.push(this.parseConcat());
    return options.length === 1 ? options[0] : { kind: "alt", options };
  }

  // concat := rep*
  parseConcat(): Node {
    const parts: Node[] = [];
    while (!this.atEnd() && this.peek() !== "|" && this.peek() !== ")") {
      parts.push(this.parseRep());
    }
    if (parts.length === 0) return { kind: "empty" };
    return parts.length === 1 ? parts[0] : { kind: "concat", parts };
  }

  // rep := atom ('*' | '+' | '?' | '{m}' | '{m,}' | '{m,n}')?
  parseRep(): Node {
    const atom = this.parseAtom();
    const bounds = this.tryQuantifier();
    if (!bounds) return atom;
    if (atom.kind === "assert") {
      // '^*' is accepted by V8 as a quantified assertion but is pure noise.
      // Rejecting keeps the supported language small and well defined.
      this.fail("quantifier applied to an anchor");
    }
    if (this.tryQuantifier()) this.fail("nothing to repeat: double quantifier");
    return { kind: "repeat", body: atom, min: bounds[0], max: bounds[1] };
  }

  /** Returns [min, max] or null. Never consumes input on a failed attempt. */
  tryQuantifier(): [number, number] | null {
    const ch = this.peek();
    if (ch === "*") {
      this.pos += 1;
      return [0, Infinity];
    }
    if (ch === "+") {
      this.pos += 1;
      return [1, Infinity];
    }
    if (ch === "?") {
      this.pos += 1;
      return [0, 1];
    }
    if (ch !== "{") return null;
    const start = this.pos;
    this.pos += 1;
    const min = this.readInt();
    if (min === null) {
      // A '{' that does not start a counted quantifier is a literal brace in
      // JavaScript's Annex B grammar. This parser rejects it instead, which is
      // narrower and unambiguous. The fuzzer never emits a bare '{'.
      this.pos = start;
      this.fail("'{' must begin a counted quantifier such as {2} or {1,3}");
    }
    let max = min;
    if (this.eat(",")) {
      const upper = this.readInt();
      max = upper === null ? Infinity : upper;
    }
    this.expect("}", "to close a counted quantifier");
    if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) {
      this.fail(`repeat bound above ${MAX_REPEAT}`);
    }
    if (max !== Infinity && max < min) this.fail("repeat range is inverted");
    return [min, max];
  }

  readInt(): number | null {
    let digits = "";
    while (this.peek() >= "0" && this.peek() <= "9") digits += this.next();
    if (digits.length === 0) return null;
    return Number.parseInt(digits, 10);
  }

  // atom := '(' alt ')' | '(?:' alt ')' | '[' class ']' | '.' | '^' | '$'
  //       | literal | escape
  parseAtom(): Node {
    const ch = this.peek();
    if (ch === "(") return this.parseGroup();
    if (ch === "[") return { kind: "class", set: this.parseClass() };
    if (ch === ".") {
      this.pos += 1;
      return { kind: "class", set: DOT };
    }
    if (ch === "^") {
      this.pos += 1;
      return { kind: "assert", at: "bol" };
    }
    if (ch === "$") {
      this.pos += 1;
      return { kind: "assert", at: "eol" };
    }
    if (ch === "\\") return this.parseEscape();
    if (ch === "*" || ch === "+" || ch === "?") this.fail(`nothing to repeat before '${ch}'`);
    if (ch === ")") this.fail("unmatched ')'");
    if (ch === "") this.fail("unexpected end of pattern");
    this.pos += 1;
    return { kind: "char", code: ch.charCodeAt(0) };
  }

  parseGroup(): Node {
    this.expect("(", "to open a group");
    if (this.peek() === "?") {
      const marker = this.peek(1);
      if (marker === ":") {
        this.pos += 2;
        const body = this.parseAlt();
        this.expect(")", "to close a group");
        return { kind: "noncap", body };
      }
      if (marker === "=" || marker === "!") {
        this.fail("lookahead is not supported: it cannot be matched in one linear pass");
      }
      if (marker === "<") {
        const after = this.peek(2);
        if (after === "=" || after === "!") {
          this.fail("lookbehind is not supported: it cannot be matched in one linear pass");
        }
        this.fail("named groups are not supported");
      }
      this.fail(`unsupported group prefix '(?${marker}'`);
    }
    const index = ++this.groupCount;
    const body = this.parseAlt();
    this.expect(")", "to close a group");
    return { kind: "group", body, index };
  }

  parseEscape(): Node {
    this.expect("\\", "to begin an escape");
    const ch = this.next();
    if (ch === "") this.fail("trailing backslash");
    if (ch >= "1" && ch <= "9") {
      this.fail("backreferences are not supported: they force a backtracking matcher");
    }
    if (ch === "b" || ch === "B") {
      this.fail(`'\\${ch}' word boundaries are not supported`);
    }
    if (ch === "k") this.fail("named backreferences are not supported");
    const shorthand = SHORTHAND[ch];
    if (shorthand) return { kind: "class", set: shorthand };
    if (ch in ESCAPED_LITERALS) return { kind: "char", code: ESCAPED_LITERALS[ch] };
    if (ch === "x") return { kind: "char", code: this.readHex(2) };
    if (ch === "u") return { kind: "char", code: this.readHex(4) };
    if (METACHARS.includes(ch)) return { kind: "char", code: ch.charCodeAt(0) };
    this.fail(`unsupported escape '\\${ch}'`);
  }

  readHex(width: number): number {
    let digits = "";
    for (let i = 0; i < width; i++) {
      const c = this.peek();
      const isHex =
        (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
      if (!isHex) this.fail(`expected ${width} hex digits`);
      digits += this.next();
    }
    return Number.parseInt(digits, 16);
  }

  // class := '^'? classItem*   (between the surrounding brackets)
  parseClass(): ClassSet {
    this.expect("[", "to open a character class");
    const negate = this.eat("^");
    const ranges: Range[] = [];
    let empty = true;
    while (!this.eat("]")) {
      if (this.atEnd()) this.fail("unterminated character class");
      empty = false;
      const lo = this.parseClassAtom(ranges);
      if (lo === null) continue; // a shorthand class was spliced in whole
      if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== "") {
        this.pos += 1;
        const hi = this.parseClassAtom(ranges);
        if (hi === null) this.fail("a shorthand class cannot be a range endpoint");
        if (hi < lo) this.fail("character class range is out of order");
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    if (empty) {
      // '[]' never matches and '[^]' matches anything, as in JavaScript.
      return negate ? makeClass([[0, 0xffff]], false) : makeClass([], false);
    }
    return makeClass(ranges, negate);
  }

  /**
   * Reads one class member. Returns its code point, or null after splicing a
   * shorthand class (\d, \w, \s and friends) directly into `ranges`.
   */
  parseClassAtom(ranges: Range[]): number | null {
    const ch = this.next();
    if (ch !== "\\") return ch.charCodeAt(0);
    const esc = this.next();
    if (esc === "") this.fail("trailing backslash in character class");
    const shorthand = SHORTHAND[esc];
    if (shorthand) {
      if (shorthand.negate) {
        // Splice the complement as explicit ranges over the BMP.
        let prev = 0;
        for (const [a, b] of shorthand.ranges) {
          if (a > prev) ranges.push([prev, a - 1]);
          prev = b + 1;
        }
        if (prev <= 0xffff) ranges.push([prev, 0xffff]);
      } else {
        for (const r of shorthand.ranges) ranges.push(r);
      }
      return null;
    }
    if (esc in ESCAPED_LITERALS) return ESCAPED_LITERALS[esc];
    if (esc === "x") return this.readHex(2);
    if (esc === "u") return this.readHex(4);
    if (esc === "b") return 0x08; // backspace inside a class, as in JavaScript
    if (METACHARS.includes(esc)) return esc.charCodeAt(0);
    this.fail(`unsupported escape '\\${esc}' in character class`);
  }
}
