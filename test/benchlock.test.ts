import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  KNOWN_FLAGS,
  MalformedMarkerError,
  UnknownFlagError,
  UnknownMetricError,
  parseArgs,
  check,
  findMarkers,
  flatten,
  formatValue,
  parseCommitted,
  rewrite,
  toleranceFor,
} from "../tools/benchlock.ts";

const METRICS = {
  "fuzz.acceptanceAgreed": 25000,
  "fuzz.divergenceCount": 0,
  "vm.programs.plus": 5,
};

describe("flatten", () => {
  it("turns nested objects into dotted keys", () => {
    assert.deepEqual(flatten({ a: { b: 1, c: { d: 2 } } }), { "a.b": 1, "a.c.d": 2 });
  });

  it("applies a prefix", () => {
    assert.deepEqual(flatten({ a: 1 }, "fuzz"), { "fuzz.a": 1 });
  });

  it("records array lengths rather than contents", () => {
    assert.deepEqual(flatten({ divergences: [1, 2, 3] }), { "divergences.length": 3 });
  });

  it("keeps booleans as zero or one and drops non-finite numbers", () => {
    assert.deepEqual(flatten({ ok: true, bad: false, inf: Infinity, nan: NaN, s: "x" }), {
      ok: 1,
      bad: 0,
    });
  });
});

describe("marker parsing", () => {
  it("finds a marker and its committed value", () => {
    const text = "we ran <!--bench:fuzz.acceptanceAgreed-->24,999<!--/bench--> pairs";
    const markers = findMarkers(text);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].key, "fuzz.acceptanceAgreed");
    assert.equal(markers[0].raw, "24,999");
  });

  it("finds several markers on one line", () => {
    const text = "<!--bench:a-->1<!--/bench--> and <!--bench:b-->2<!--/bench-->";
    assert.deepEqual(
      findMarkers(text).map((m) => [m.key, m.raw]),
      [
        ["a", "1"],
        ["b", "2"],
      ],
    );
  });

  it("returns nothing for text with no markers", () => {
    assert.deepEqual(findMarkers("plain prose"), []);
  });

  it("parses a committed value with thousands separators", () => {
    assert.equal(parseCommitted("1,000,000"), 1000000);
    assert.equal(parseCommitted(" 42 "), 42);
  });

  it("formats integers with separators", () => {
    assert.equal(formatValue(1000000), "1,000,000");
    assert.equal(formatValue(0), "0");
  });
});

describe("malformed markers are rejected", () => {
  it("rejects an opening marker with no close", () => {
    assert.throws(
      () => findMarkers("before <!--bench:fuzz.acceptance-->24999 after"),
      MalformedMarkerError,
    );
  });

  it("rejects an unterminated opening comment", () => {
    assert.throws(() => findMarkers("<!--bench:fuzz.acceptance"), MalformedMarkerError);
  });

  it("rejects an empty metric key", () => {
    assert.throws(() => findMarkers("<!--bench:-->1<!--/bench-->"), MalformedMarkerError);
  });

  it("rejects a nested or overlapping marker", () => {
    assert.throws(
      () => findMarkers("<!--bench:a--><!--bench:b-->1<!--/bench--><!--/bench-->"),
      MalformedMarkerError,
    );
  });

  it("rejects a stray closing marker", () => {
    assert.throws(() => findMarkers("dangling <!--/bench--> here"), MalformedMarkerError);
  });

  it("rejects a committed value that is not a number", () => {
    assert.throws(
      () => check("<!--bench:fuzz.divergenceCount-->none<!--/bench-->", METRICS),
      MalformedMarkerError,
    );
  });

  it("rejects a marker naming a metric the tools do not produce", () => {
    assert.throws(
      () => check("<!--bench:fuzz.madeUp-->1<!--/bench-->", METRICS),
      UnknownMetricError,
    );
    assert.throws(
      () => rewrite("<!--bench:fuzz.madeUp-->1<!--/bench-->", METRICS),
      UnknownMetricError,
    );
  });
});

describe("command line parsing", () => {
  it("accepts no flags, meaning the rewrite mode", () => {
    assert.deepEqual(parseArgs([]), { check: false, json: false });
  });

  it("accepts the two real flags, together or apart", () => {
    assert.deepEqual(parseArgs(["--check"]), { check: true, json: false });
    assert.deepEqual(parseArgs(["--json"]), { check: false, json: true });
    assert.deepEqual(parseArgs(["--check", "--json"]), { check: true, json: true });
  });

  it("refuses an unknown flag rather than falling through to the write path", () => {
    // The whole point: the no-flag mode rewrites README.md, so a mistyped flag
    // used to silently edit the artefact this tool exists to guard.
    for (const bad of ["--list", "--heck", "-c", "check", "--CHECK", "--json=1"]) {
      assert.throws(
        () => parseArgs([bad]),
        (err: unknown) => {
          assert.ok(err instanceof UnknownFlagError, `${bad} should raise UnknownFlagError`);
          assert.match(err.message, /unknown flag/);
          return true;
        },
        `parseArgs([${JSON.stringify(bad)}]) should have thrown`,
      );
    }
  });

  it("refuses an unknown flag even when a real one is also present", () => {
    assert.throws(() => parseArgs(["--check", "--oops"]), UnknownFlagError);
    assert.throws(() => parseArgs(["--oops", "--check"]), UnknownFlagError);
  });

  it("names the accepted flags in the error", () => {
    try {
      parseArgs(["--nope"]);
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof UnknownFlagError);
      for (const flag of KNOWN_FLAGS) assert.match(err.message, new RegExp(flag));
    }
  });
});

describe("tolerances", () => {
  it("defaults to exact", () => {
    assert.deepEqual(toleranceFor("vm.programs.plus"), { abs: 0 });
  });

  it("picks the longest matching prefix", () => {
    assert.deepEqual(toleranceFor("fuzz.acceptanceAgreed"), { rel: 0.002 });
    assert.deepEqual(toleranceFor("fuzz.divergenceCount"), { abs: 0 });
  });
});

describe("check", () => {
  it("passes when a committed figure matches exactly", () => {
    const text = "<!--bench:vm.programs.plus-->5<!--/bench-->";
    assert.deepEqual(check(text, METRICS), []);
  });

  it("passes when a committed figure is inside its relative tolerance", () => {
    // 25,000 with a 0.2% allowance tolerates a drift of 50.
    const text = "<!--bench:fuzz.acceptanceAgreed-->24,970<!--/bench-->";
    assert.deepEqual(check(text, METRICS), []);
  });

  it("fails when a committed figure has drifted past its tolerance", () => {
    const text = "<!--bench:fuzz.acceptanceAgreed-->24,000<!--/bench-->";
    const drifts = check(text, METRICS);
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0].key, "fuzz.acceptanceAgreed");
    assert.equal(drifts[0].committed, 24000);
    assert.equal(drifts[0].fresh, 25000);
    assert.equal(drifts[0].delta, 1000);
    assert.equal(drifts[0].allowed, 50);
  });

  it("fails on any drift at all for a zero-tolerance key", () => {
    const text = "<!--bench:fuzz.divergenceCount-->1<!--/bench-->";
    assert.equal(check(text, METRICS).length, 1);
    assert.deepEqual(check("<!--bench:fuzz.divergenceCount-->0<!--/bench-->", METRICS), []);
  });

  it("reports every drifted figure, not just the first", () => {
    const text =
      "<!--bench:vm.programs.plus-->9<!--/bench--> and <!--bench:fuzz.divergenceCount-->3<!--/bench-->";
    assert.deepEqual(
      check(text, METRICS).map((d) => d.key),
      ["vm.programs.plus", "fuzz.divergenceCount"],
    );
  });
});

describe("rewrite", () => {
  it("replaces committed values and leaves the surrounding prose alone", () => {
    const text = "ran <!--bench:fuzz.acceptanceAgreed-->1<!--/bench--> pairs, no drift.";
    assert.equal(
      rewrite(text, METRICS),
      "ran <!--bench:fuzz.acceptanceAgreed-->25,000<!--/bench--> pairs, no drift.",
    );
  });

  it("is idempotent", () => {
    const once = rewrite("<!--bench:vm.programs.plus-->0<!--/bench-->", METRICS);
    assert.equal(rewrite(once, METRICS), once);
  });

  it("leaves text with no markers unchanged", () => {
    assert.equal(rewrite("nothing to see", METRICS), "nothing to see");
  });

  it("round-trips through check", () => {
    const text = "a <!--bench:fuzz.acceptanceAgreed-->0<!--/bench--> b";
    assert.deepEqual(check(rewrite(text, METRICS), METRICS), []);
  });
});
