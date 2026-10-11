import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Regex } from "../src/index.ts";

// Linearity is asserted structurally, by counting the work the VM performs,
// rather than by timing it. A stopwatch assertion is flaky on shared CI
// hardware and it proves nothing about the algorithm; a bound on admitted
// thread count is exact, deterministic and identical on every machine.
//
// The bound: each of the (inputLength + 1) input positions owns one sparse set
// over program counters, and a counter may be admitted to it at most once. So
//
//     addsPerformed <= (inputLength + 1) * program.length
//
// and no pattern, however adversarial, can exceed it.

const PATTERNS = [
  "^(a|aa)+$",
  "(a+)+$",
  "(a+)+b",
  "(x+x+)+y",
  "(a*)*b",
  "(a|a?)+$",
  "([a-zA-Z]+)*$",
  "(a|b|ab)+c",
  "^(\\w+\\s?)*$",
  "(.*a){10}b",
  "^(a?){20}a{20}$",
  "((a)*)*b",
  "(\\d+)-(\\d+)",
  "a.*b.*c",
  "(?:ab|a)+c",
];

function filler(pattern: string, n: number): string {
  if (pattern.includes("x")) return "x".repeat(n);
  if (pattern.includes("\\d")) return "1".repeat(n);
  if (pattern.includes("\\w") || pattern.includes("a-zA-Z")) return "a".repeat(n);
  return "a".repeat(n);
}

describe("structural linearity bound", () => {
  for (const pattern of PATTERNS) {
    it(`/${pattern}/ stays inside (n + 1) * progLen admitted threads`, () => {
      const re = new Regex(pattern);
      const progLen = re.program.insts.length;
      for (const n of [0, 1, 2, 5, 17, 64, 257, 1024]) {
        const input = filler(pattern, n);
        re.test(input);
        const limit = (input.length + 1) * progLen;
        assert.ok(
          re.stats.addsPerformed <= limit,
          `/${pattern}/ on ${input.length} chars admitted ${re.stats.addsPerformed} ` +
            `threads, above the ${limit} bound`,
        );
        assert.ok(
          re.stats.charSteps <= limit,
          `/${pattern}/ stepped ${re.stats.charSteps} threads, above the ${limit} bound`,
        );
        assert.ok(
          re.stats.maxListSize <= progLen,
          `/${pattern}/ held ${re.stats.maxListSize} runnable threads in one column, ` +
            `above the ${progLen} instruction count`,
        );
      }
    });
  }

  it("holds with captures enabled as well as disabled", () => {
    const re = new Regex("^(a|aa)+$");
    const progLen = re.program.insts.length;
    const input = "a".repeat(512);
    re.exec(input);
    assert.ok(re.stats.addsPerformed <= (input.length + 1) * progLen);
  });
});

describe("work grows linearly, not just boundedly", () => {
  it("doubling the input roughly doubles the admitted thread count", () => {
    for (const pattern of ["^(a|aa)+$", "(a+)+$", "(x+x+)+y"]) {
      const re = new Regex(pattern);
      re.test(filler(pattern, 1000));
      const small = re.stats.addsPerformed;
      re.test(filler(pattern, 2000));
      const large = re.stats.addsPerformed;
      const ratio = large / small;
      assert.ok(
        ratio > 1.8 && ratio < 2.2,
        `/${pattern}/ scaled by ${ratio.toFixed(3)} when the input doubled`,
      );
    }
  });

  it("admits at most one thread per program counter per position", () => {
    const re = new Regex("(a|aa|aaa)+b");
    const input = "a".repeat(300);
    re.run(input, { captures: false, trace: true });
    for (const column of re.trace) {
      assert.equal(new Set(column).size, column.length, "a column held a duplicate pc");
      assert.ok(column.length <= re.program.insts.length);
    }
  });
});
