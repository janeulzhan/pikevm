import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Regex } from "../src/index.ts";

// Twelve patterns from the usual catastrophic-backtracking catalogue, each
// paired with the input that makes a backtracking engine explode.
//
// What is asserted here is the amount of work the VM does, not how long it
// takes. A wall-clock assertion tight enough to be meaningful is also tight
// enough to fail on a loaded test runner, and it proves nothing the thread
// count does not already prove. The measured timings live in
// bench/results.json and in the README table that is explicitly not CI-gated.

export const REDOS_CASES: { pattern: string; input: (n: number) => string; n: number }[] = [
  { pattern: "^(a|aa)+$", input: (n) => `${"a".repeat(n)}b`, n: 40 },
  { pattern: "(a+)+$", input: (n) => `${"a".repeat(n)}!`, n: 40 },
  { pattern: "(a+)+b", input: (n) => "a".repeat(n), n: 40 },
  { pattern: "(x+x+)+y", input: (n) => "x".repeat(n), n: 40 },
  { pattern: "(a*)*b", input: (n) => "a".repeat(n), n: 2000 },
  { pattern: "(a|a?)+$", input: (n) => `${"a".repeat(n)}b`, n: 40 },
  { pattern: "([a-zA-Z]+)*$", input: (n) => `${"a".repeat(n)}1`, n: 40 },
  { pattern: "(a|b|ab)+c", input: (n) => "ab".repeat(n), n: 24 },
  { pattern: "^(\\w+\\s?)*$", input: (n) => `${"a".repeat(n)}!`, n: 40 },
  { pattern: "(.*a){20}b", input: (n) => "a".repeat(n), n: 60 },
  { pattern: "^(a?){25}a{25}$", input: (n) => "a".repeat(n), n: 24 },
  { pattern: "((a)*)*b", input: (n) => "a".repeat(n), n: 500 },
];

describe("known ReDoS patterns do a bounded amount of work", () => {
  for (const { pattern, input, n } of REDOS_CASES) {
    it(`/${pattern}/ on ${n} characters stays inside the linear bound`, () => {
      const re = new Regex(pattern);
      const subject = input(n);
      re.test(subject);
      const progLen = re.program.insts.length;
      const bound = (subject.length + 1) * progLen;
      assert.ok(
        re.stats.addsPerformed <= bound,
        `/${pattern}/ admitted ${re.stats.addsPerformed} threads, above the ${bound} bound`,
      );
      assert.ok(
        re.stats.maxListSize <= progLen,
        `/${pattern}/ held ${re.stats.maxListSize} threads in one column, above ${progLen}`,
      );
    });
  }

  it("finishes every catalogue pattern well inside a liveness ceiling", () => {
    // Deliberately loose. This catches a hang, not a slowdown; the numbers
    // worth quoting are measured by bench/redos.ts on known hardware.
    for (const { pattern, input, n } of REDOS_CASES) {
      const re = new Regex(pattern);
      const subject = input(n);
      re.test(subject);
      const start = performance.now();
      re.test(subject);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 100, `/${pattern}/ took ${elapsed.toFixed(2)} ms`);
    }
  });

  it("agrees with the platform engine on every case at a safe size", () => {
    for (const { pattern, input } of REDOS_CASES) {
      // Small inputs only: at full size the platform engine would not return.
      const subject = input(6);
      assert.equal(
        new Regex(pattern).test(subject),
        new RegExp(pattern).test(subject),
        `/${pattern}/ disagrees on ${JSON.stringify(subject)}`,
      );
    }
  });

  it("covers twelve distinct patterns", () => {
    assert.equal(REDOS_CASES.length, 12);
    assert.equal(new Set(REDOS_CASES.map((c) => c.pattern)).size, 12);
  });
});
