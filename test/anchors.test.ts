import { describe, it } from "node:test";
import { expectAccepts, expectSlices } from "./helpers.ts";

describe("anchors", () => {
  it("anchors at the start", () => {
    expectAccepts("^ab", "abc", true);
    expectAccepts("^ab", "xabc", false);
  });

  it("anchors at the end", () => {
    expectAccepts("bc$", "abc", true);
    expectAccepts("bc$", "abcd", false);
  });

  it("anchors both ends", () => {
    expectAccepts("^abc$", "abc", true);
    expectAccepts("^abc$", "abcd", false);
    expectAccepts("^abc$", "zabc", false);
  });

  it("matches the empty string against both anchors", () => {
    expectSlices("^$", "", [""]);
    expectAccepts("^$", "x", false);
  });

  it("does not treat a newline as a line boundary without the multiline flag", () => {
    expectAccepts("^b", "a\nb", false);
    expectAccepts("a$", "a\nb", false);
  });

  it("makes an unsatisfiable mid-pattern anchor fail", () => {
    expectAccepts("a^b", "ab", false);
    expectAccepts("a$b", "ab", false);
  });

  it("allows an anchor inside an alternative", () => {
    expectAccepts("(^a|b)c", "ac", true);
    expectAccepts("(^a|b)c", "xac", false);
    expectAccepts("(^a|b)c", "xbc", true);
  });
});
