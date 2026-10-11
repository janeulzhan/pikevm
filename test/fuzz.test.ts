import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_SEED, sweep } from "../tools/fuzz.ts";
import { pairAt } from "../tools/fuzz-core.ts";
import { Regex } from "../src/index.ts";
import { Rng, genPattern, isSpanComparable, mulberry32 } from "../tools/gen.ts";
import { parse } from "../src/parser.ts";

// The sweep CI runs is smaller than the one run locally. Both numbers are in the
// README, labelled, so nobody has to guess which is which.
const CI_ITERATIONS = 25000;

describe("differential fuzz against the platform engine", () => {
  it(`agrees on ${CI_ITERATIONS.toLocaleString()} generated pairs`, async () => {
    const report = await sweep({ seed: DEFAULT_SEED, iterations: CI_ITERATIONS });
    assert.deepEqual(
      report.divergences,
      [],
      `divergences:\n${report.divergences
        .map((d) => `  [${d.kind}] /${d.pattern}/ on ${JSON.stringify(d.input)}: ours ${d.ours}, theirs ${d.theirs}`)
        .join("\n")}`,
    );
    assert.equal(report.acceptanceAgreed, report.acceptance);
    assert.equal(report.spanAgreed, report.spanCompared);
    assert.equal(report.wholeMatchAgreed, report.acceptanceAgreed);
    // Guard against a sweep that passes because nothing matched.
    assert.ok(
      report.matched > CI_ITERATIONS * 0.4,
      `only ${report.matched} of ${CI_ITERATIONS} pairs matched; the generator is not exercising much`,
    );
    assert.ok(
      report.patternsWithGroups > 5000,
      `only ${report.patternsWithGroups} distinct patterns carried capture groups`,
    );
  });

  it("answers every recorded oracle stall promptly", () => {
    // These are the pairs the platform engine could not finish inside the
    // deadline. Our engine must answer all of them, and fast.
    const file = JSON.parse(
      readFileSync(new URL("./oracle-timeouts.json", import.meta.url), "utf8"),
    ) as { seeds: Record<string, number[]> };
    const indices = file.seeds[String(DEFAULT_SEED)] ?? [];
    assert.ok(indices.length > 0, "expected at least one recorded oracle stall");
    for (const i of indices) {
      const { pattern, input } = pairAt(DEFAULT_SEED, i);
      const re = new Regex(pattern);
      re.test(input);
      const t = performance.now();
      re.test(input);
      const elapsed = performance.now() - t;
      assert.ok(
        elapsed < 5,
        `/${pattern}/ took ${elapsed.toFixed(3)} ms, which is slow for a pattern the oracle cannot finish at all`,
      );
    }
  });
});

describe("generator", () => {
  it("is deterministic for a given seed", () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    for (let i = 0; i < 200; i++) assert.equal(genPattern(a), genPattern(b));
  });

  it("produces different streams for different seeds", () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const left: string[] = [];
    const right: string[] = [];
    for (let i = 0; i < 50; i++) {
      left.push(genPattern(a));
      right.push(genPattern(b));
    }
    assert.notDeepEqual(left, right);
  });

  it("mulberry32 stays inside the unit interval", () => {
    const next = mulberry32(7);
    for (let i = 0; i < 10000; i++) {
      const v = next();
      assert.ok(v >= 0 && v < 1, `drew ${v}`);
    }
  });

  it("every generated pattern parses", () => {
    const rng = new Rng(99);
    for (let i = 0; i < 3000; i++) {
      const p = genPattern(rng);
      assert.doesNotThrow(() => parse(p), `generator produced an unparseable pattern /${p}/`);
    }
  });

  it("reproduces any pair from its seed and index", () => {
    const first = pairAt(DEFAULT_SEED, 500);
    const second = pairAt(DEFAULT_SEED, 500);
    assert.deepEqual(first, second);
    assert.notDeepEqual(first, pairAt(DEFAULT_SEED, 501));
  });
});

describe("span comparability predicate", () => {
  const comparable = ["(a)b", "a(b|c)d", "(a)(b)", "a*(b)", "(?:a)+(b)", "^(ab)$"];
  const notComparable = ["(a)*", "(a)+", "(a)?", "(?:(a)|b)+", "((a))*", "(a){2,3}"];

  for (const p of comparable) {
    it(`/${p}/ is span comparable`, () => {
      assert.equal(isSpanComparable(parse(p).ast), true);
    });
  }
  for (const p of notComparable) {
    it(`/${p}/ is excluded from the conservative subset`, () => {
      assert.equal(isSpanComparable(parse(p).ast), false);
    });
  }
});
