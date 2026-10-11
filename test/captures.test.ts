import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Regex } from "../src/index.ts";
import { expectSlices, spans } from "./helpers.ts";

describe("submatch capture", () => {
  it("captures two numeric fields", () => {
    expectSlices("(\\d+)-(\\d+)", "12-345", ["12-345", "12", "345"]);
  });

  it("reports absolute spans, not relative ones", () => {
    assert.deepEqual(spans("(\\d+)-(\\d+)", "xx 12-345 yy"), [
      [3, 9],
      [3, 5],
      [6, 9],
    ]);
  });

  it("leaves an unvisited group null", () => {
    expectSlices("(a)|(b)", "b", ["b", null, "b"]);
  });

  it("captures nested groups", () => {
    expectSlices("((a)(b))c", "abc", ["abc", "ab", "a", "b"]);
  });

  it("ignores non-capturing groups in numbering", () => {
    expectSlices("(?:a)(b)(?:c)(d)", "abcd", ["abcd", "b", "d"]);
  });

  it("keeps the last iteration of a quantified group", () => {
    expectSlices("(?:(a|b))+", "ab", ["ab", "b"]);
  });

  it("captures an empty span distinctly from no span", () => {
    const m = new Regex("(a*)b").exec("b");
    assert.ok(m);
    assert.deepEqual(m.groups, [
      [0, 1],
      [0, 0],
    ]);
    assert.deepEqual(m.slices, ["b", ""]);
  });

  it("captures a date-like shape", () => {
    expectSlices("(\\d{4})-(\\d{2})-(\\d{2})", "on 2026-10-11!", [
      "2026-10-11",
      "2026",
      "10",
      "11",
    ]);
  });

  it("reports group count from the compiled program", () => {
    assert.equal(new Regex("(a)(?:b)((c))").groupCount, 3);
    assert.equal(new Regex("abc").groupCount, 0);
  });
});

describe("leftmost-first preference", () => {
  it("prefers the earlier alternative even when it is shorter", () => {
    expectSlices("a|ab", "ab", ["a"]);
    assert.equal(new RegExp("a|ab").exec("ab")?.[0], "a");
  });

  it("prefers the longer alternative when it is listed first", () => {
    expectSlices("ab|a", "ab", ["ab"]);
  });

  it("prefers an earlier start position over a longer match", () => {
    expectSlices("a+", "aa baaa", ["aa"]);
  });

  it("is greedy within a quantifier", () => {
    expectSlices("a*", "aaa", ["aaa"]);
    expectSlices("(a+)(a*)", "aaaa", ["aaaa", "aaaa", ""]);
  });
});
