import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Regex } from "../src/index.ts";

// Twelve patterns from the usual catastrophic-backtracking catalogue, each
// paired with the input that makes a backtracking engine explode. The timing
// assertion here is a loose ceiling used as a smoke test; the honest measured
// numbers live in bench/results.json and in the README's wall-clock table.

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

describe("known ReDoS patterns complete promptly", () => {
  for (const { pattern, input, n } of REDOS_CASES) {
    it(`/${pattern}/ on ${n} characters finishes under 1 ms`, () => {
      const re = new Regex(pattern);
      const subject = input(n);
      re.test(subject); // warm the compiled program and the thread lists
      const start = performance.now();
      re.test(subject);
      const elapsed = performance.now() - start;
      assert.ok(
        elapsed < 1,
        `/${pattern}/ took ${elapsed.toFixed(4)} ms, above the 1 ms ceiling`,
      );
    });
  }

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
