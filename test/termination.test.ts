import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Regex } from "../src/index.ts";
import { expectAccepts, expectSlices } from "./helpers.ts";

// Every pattern here contains a quantified body that can match the empty
// string. A backtracking matcher without an empty-loop check loops forever on
// them; the Pike VM cannot, because the sparse set refuses the second visit to
// the loop head at a given input position.

describe("empty loop bodies terminate", () => {
  const cases: [string, string, boolean][] = [
    ["(a*)*b", "aaab", true],
    ["(a*)*b", "aaa", false],
    ["(a*)*", "aaa", true],
    ["(a|)*b", "aab", true],
    ["(a|)*b", "aa", false],
    ["((a*)*)*b", "aaab", true],
    ["(a?)*b", "aab", true],
    ["(|a)+b", "b", true],
    ["(a{0,2})*b", "aaaab", true],
    ["()*", "", true],
    ["(()*)*x", "x", true],
  ];

  for (const [pattern, input, want] of cases) {
    it(`/${pattern}/ on ${JSON.stringify(input)} terminates`, () => {
      expectAccepts(pattern, input, want);
    });
  }

  it("terminates on a long input to an empty star", () => {
    const re = new Regex("(a*)*b");
    assert.equal(re.test("a".repeat(5000)), false);
    assert.ok(re.stats.addsPerformed > 0);
  });

  it("still reports a sensible capture for an empty-matching body", () => {
    expectSlices("(a*)*b", "aab", ["aab", "aa"]);
  });
});
