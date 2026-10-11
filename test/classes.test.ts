import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Regex, classMatches, describeClass, parse } from "../src/index.ts";
import { expectAccepts, expectSlices } from "./helpers.ts";

function setOf(pattern: string) {
  const ast = parse(pattern).ast;
  assert.equal(ast.kind, "class");
  if (ast.kind !== "class") throw new Error("unreachable");
  return ast.set;
}

describe("character classes", () => {
  it("matches a simple enumeration", () => {
    expectAccepts("[abc]", "b", true);
    expectAccepts("[abc]", "d", false);
  });

  it("matches ranges", () => {
    expectAccepts("[a-f]", "c", true);
    expectAccepts("[a-f]", "g", false);
    expectAccepts("[0-9a-fA-F]+", "DeadBeef99", true);
  });

  it("negates", () => {
    expectAccepts("[^a-z]", "Q", true);
    expectAccepts("[^a-z]", "q", false);
  });

  it("treats a leading or trailing dash as a literal", () => {
    expectAccepts("[-a]", "-", true);
    expectAccepts("[a-]", "-", true);
  });

  it("rejects an out of order range", () => {
    assert.throws(() => parse("[z-a]"), /out of order/);
  });

  it("normalises overlapping and adjacent ranges", () => {
    assert.equal(describeClass(setOf("[a-ce-gd]")), "[a-g]");
    assert.equal(describeClass(setOf("[a-ca-c]")), "[a-c]");
  });

  it("splices shorthand classes inside a class", () => {
    expectAccepts("[\\d_]+", "19_84", true);
    expectAccepts("[\\d_]+", "x", false);
    expectAccepts("[\\w-]+", "a-b_9", true);
  });

  it("handles a negated shorthand inside a class", () => {
    expectAccepts("[\\D]", "5", false);
    expectAccepts("[\\D]", "x", true);
  });

  it("makes an empty class unsatisfiable and a negated empty class universal", () => {
    assert.equal(new Regex("a[]b").test("ab"), false);
    assert.equal(new Regex("a[^]b").test("axb"), true);
  });

  it("supports membership queries directly", () => {
    const s = setOf("[b-d]");
    assert.equal(classMatches(s, "a".charCodeAt(0)), false);
    assert.equal(classMatches(s, "c".charCodeAt(0)), true);
  });
});

describe("shorthand escapes", () => {
  it("matches digits, words and whitespace", () => {
    expectAccepts("\\d\\d", "42", true);
    expectAccepts("\\w+", "snake_case9", true);
    expectAccepts("a\\sb", "a b", true);
    expectAccepts("a\\sb", "a_b", false);
  });

  it("matches the complements", () => {
    expectAccepts("\\D", "x", true);
    expectAccepts("\\D", "7", false);
    expectAccepts("\\W", "!", true);
    expectAccepts("\\S+", "abc", true);
  });

  it("dot excludes line terminators, matching the default flagless engine", () => {
    expectAccepts("a.b", "axb", true);
    expectAccepts("a.b", "a\nb", false);
  });

  it("accepts escaped metacharacters as literals", () => {
    expectSlices("a\\.b", "a.b", ["a.b"]);
    expectAccepts("a\\.b", "axb", false);
    expectSlices("\\(\\)", "()", ["()"]);
    expectSlices("\\$\\^", "$^", ["$^"]);
  });

  it("accepts hex and unicode escapes", () => {
    expectAccepts("\\x41", "A", true);
    expectAccepts("\\u0041", "A", true);
  });
});
