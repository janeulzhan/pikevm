import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RegexSyntaxError, parse } from "../src/index.ts";

function shape(pattern: string): string {
  return describe_(parse(pattern).ast);
}

// A compact structural rendering, enough to pin down precedence.
function describe_(n: ReturnType<typeof parse>["ast"]): string {
  switch (n.kind) {
    case "empty":
      return "()";
    case "char":
      return String.fromCharCode(n.code);
    case "class":
      return "[]";
    case "assert":
      return n.at === "bol" ? "^" : "$";
    case "concat":
      return `cat(${n.parts.map(describe_).join(",")})`;
    case "alt":
      return `alt(${n.options.map(describe_).join(",")})`;
    case "repeat":
      return `rep(${describe_(n.body)},${n.min},${n.max})`;
    case "group":
      return `grp${n.index}(${describe_(n.body)})`;
    case "noncap":
      return `nc(${describe_(n.body)})`;
  }
}

describe("parser precedence", () => {
  it("binds concatenation tighter than alternation", () => {
    assert.equal(shape("ab|cd"), "alt(cat(a,b),cat(c,d))");
  });

  it("binds quantifiers tighter than concatenation", () => {
    assert.equal(shape("ab*"), "cat(a,rep(b,0,Infinity))");
  });

  it("keeps alternation flat across several bars", () => {
    assert.equal(shape("a|b|c"), "alt(a,b,c)");
  });

  it("allows empty alternatives", () => {
    assert.equal(shape("a|"), "alt(a,())");
    assert.equal(shape("(|a)"), "grp1(alt((),a))");
  });

  it("numbers capture groups in source order and skips non-capturing ones", () => {
    assert.equal(parse("(a)(?:b)(c)").groupCount, 2);
    assert.equal(shape("(a)(?:b)(c)"), "cat(grp1(a),nc(b),grp2(c))");
  });

  it("numbers nested groups outside in", () => {
    assert.equal(shape("((a))"), "grp1(grp2(a))");
  });
});

describe("quantifier forms", () => {
  it("parses the three sugar forms", () => {
    assert.equal(shape("a*"), "rep(a,0,Infinity)");
    assert.equal(shape("a+"), "rep(a,1,Infinity)");
    assert.equal(shape("a?"), "rep(a,0,1)");
  });

  it("parses counted forms", () => {
    assert.equal(shape("a{3}"), "rep(a,3,3)");
    assert.equal(shape("a{2,}"), "rep(a,2,Infinity)");
    assert.equal(shape("a{1,4}"), "rep(a,1,4)");
  });

  it("rejects an inverted counted range", () => {
    assert.throws(() => parse("a{4,2}"), RegexSyntaxError);
  });

  it("rejects a double quantifier", () => {
    assert.throws(() => parse("a**"), RegexSyntaxError);
    assert.throws(() => parse("a+{2}"), RegexSyntaxError);
  });

  it("rejects a quantifier with nothing to repeat", () => {
    assert.throws(() => parse("*a"), RegexSyntaxError);
    assert.throws(() => parse("(*)"), RegexSyntaxError);
  });

  it("rejects a brace that does not begin a counted quantifier", () => {
    assert.throws(() => parse("a{b}"), RegexSyntaxError);
  });
});

describe("unsupported constructs are rejected with a reason", () => {
  const cases: [string, RegExp][] = [
    ["(a)\\1", /backreference/],
    ["(?=a)", /lookahead/],
    ["(?!a)", /lookahead/],
    ["(?<=a)", /lookbehind/],
    ["(?<!a)", /lookbehind/],
    ["(?<name>a)", /named group/],
    ["\\ba", /word boundar/],
  ];
  for (const [pattern, message] of cases) {
    it(`rejects ${pattern}`, () => {
      assert.throws(() => parse(pattern), (err: unknown) => {
        assert.ok(err instanceof RegexSyntaxError);
        assert.match(err.message, message);
        return true;
      });
    });
  }
});

describe("structural errors", () => {
  it("reports unbalanced parentheses", () => {
    assert.throws(() => parse("(a"), /expected '\)'/);
    assert.throws(() => parse("a)"), /unmatched/);
  });

  it("reports an unterminated class", () => {
    assert.throws(() => parse("[a"), /unterminated character class/);
  });

  it("reports a trailing backslash", () => {
    assert.throws(() => parse("a\\"), /trailing backslash/);
  });

  it("carries the offset of the failure", () => {
    try {
      parse("ab(?=c)");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof RegexSyntaxError);
      assert.equal(err.offset, 3);
    }
  });
});
