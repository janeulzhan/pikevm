import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_PROGRAM_SIZE, ProgramTooLargeError, Regex, compile, disassemble } from "../src/index.ts";
import { expectAccepts, expectSlices } from "./helpers.ts";

describe("thompson construction", () => {
  it("wraps the program in the whole-match save slots", () => {
    const p = compile("a");
    assert.deepEqual(p.insts[0], { op: "save", slot: 0 });
    assert.deepEqual(p.insts.at(-2), { op: "save", slot: 1 });
    assert.deepEqual(p.insts.at(-1), { op: "match" });
  });

  it("allocates two slots per group plus the whole match", () => {
    assert.equal(compile("(a)(b)").slotCount, 6);
    assert.equal(compile("ab").slotCount, 2);
  });

  it("encodes greedy priority in the split argument order", () => {
    const text = disassemble(compile("a*"));
    assert.match(text, /split 2, 4/);
  });

  it("emits a star as split, body, jump back", () => {
    assert.equal(
      disassemble(compile("a*")),
      ["0  save 0", "1  split 2, 4", "2  char \"a\"", "3  jump 1", "4  save 1", "5  match"].join("\n"),
    );
  });

  it("emits a plus as body then a split back", () => {
    assert.equal(
      disassemble(compile("a+")),
      ["0  save 0", "1  char \"a\"", "2  split 1, 3", "3  save 1", "4  match"].join("\n"),
    );
  });
});

describe("counted repetition expansion", () => {
  it("duplicates the body exactly min times for {m}", () => {
    const p = compile("a{3}");
    assert.equal(p.insts.filter((i) => i.op === "char").length, 3);
  });

  it("emits min copies then a star for {m,}", () => {
    expectAccepts("^a{2,}$", "a", false);
    expectAccepts("^a{2,}$", "aa", true);
    expectAccepts("^a{2,}$", "aaaaa", true);
  });

  it("bounds {m,n} on both sides", () => {
    expectAccepts("^a{2,4}$", "a", false);
    expectAccepts("^a{2,4}$", "aa", true);
    expectAccepts("^a{2,4}$", "aaaa", true);
    expectAccepts("^a{2,4}$", "aaaaa", false);
  });

  it("treats {0} and {0,0} as nothing", () => {
    expectSlices("^a{0}$", "", [""]);
    expectAccepts("^ba{0,0}b$", "bb", true);
  });

  it("keeps one pair of capture slots across duplicated copies", () => {
    assert.equal(compile("(a){2,3}").slotCount, 4);
    expectSlices("(ab){2}", "abab", ["abab", "ab"]);
  });

  it("grows the program linearly in the repeat count", () => {
    const small = compile("a{10}").insts.length;
    const large = compile("a{20}").insts.length;
    assert.equal(large - small, 10);
  });
});

describe("program size ceiling", () => {
  it("rejects an expansion past the limit with a clear message", () => {
    assert.throws(
      () => compile("(ab|cd){4000}"),
      (err: unknown) => {
        assert.ok(err instanceof ProgramTooLargeError);
        assert.equal(err.limit, MAX_PROGRAM_SIZE);
        assert.match(err.message, /instruction limit/);
        return true;
      },
    );
  });

  it("rejects nested expansion that would explode", () => {
    assert.throws(() => compile("((a{100}){100}){100}"), ProgramTooLargeError);
  });

  it("accepts a large but legal expansion", () => {
    const re = new Regex("a{500}");
    assert.ok(re.program.insts.length < MAX_PROGRAM_SIZE);
    assert.equal(re.test("a".repeat(500)), true);
  });
});
