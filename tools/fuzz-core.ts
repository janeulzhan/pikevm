// The synchronous core of the differential fuzz: generate a pair, run both
// engines, compare. Counters live in an Int32Array so that a supervisor in
// another thread can read them even if this thread has to be terminated.
//
// Three comparisons, counted separately:
//
//   acceptance   test() against RegExp.prototype.test, on every pair
//   whole match  the span of the overall match, on every pair
//   span-exact   every capture group span, read out of the platform engine's
//                match indices via the 'd' flag, on every pair
//
// The span comparison started life restricted to a subset of patterns, because
// two ECMAScript rules are backtracking artefacts that a textbook Pike VM does
// not reproduce: an iteration past a quantifier's declared minimum must consume
// input, and the capture slots of groups inside a quantifier are cleared at the
// start of every iteration. Both are now implemented, by the progress register
// and the clear instruction, so the comparison runs on every pair. The
// conservative subset is still counted and reported next to the full figure, so
// a reader can see how much of the agreement rests on those two rules.

import type { Node } from "../src/ast.ts";
import { ProgramTooLargeError, Regex, RegexSyntaxError } from "../src/index.ts";
import { parse } from "../src/parser.ts";
import { Rng, genInput, genPattern, groupCount, isSpanComparable } from "./gen.ts";

/** Fixed slots in the shared counter array. */
export const SLOT = {
  heartbeat: 0,
  pairs: 1,
  acceptance: 2,
  acceptanceAgreed: 3,
  wholeMatchAgreed: 4,
  spanCompared: 5,
  spanAgreed: 6,
  spanSubsetCompared: 7,
  spanSubsetAgreed: 8,
  matched: 9,
  skippedTooLarge: 10,
  divergences: 11,
  oracleSkipped: 12,
  done: 13,
  pairsWithGroups: 14,
  /** Monotonic liveness tick. Moves in every phase, including the replay. */
  ticks: 15,
} as const;

export const SLOT_COUNT = 16;

export interface Divergence {
  kind: "acceptance" | "whole-match" | "span" | "parse";
  iteration: number;
  pattern: string;
  input: string;
  ours: string;
  theirs: string;
}

export interface RangeOptions {
  seed: number;
  from: number;
  to: number;
  counters: Int32Array;
  /** Iterations to skip because the oracle is known not to return on them. */
  skip?: ReadonlySet<number>;
  onDivergence?: (d: Divergence) => void;
  maxDivergences?: number;
}

/** Regenerates the pattern and input for one iteration. Deterministic. */
export function pairAt(seed: number, iteration: number): { pattern: string; input: string } {
  const rng = new Rng(seed);
  let pattern = "";
  let input = "";
  for (let i = 0; i <= iteration; i++) {
    pattern = genPattern(rng);
    input = genInput(rng);
  }
  return { pattern, input };
}

export function runRange(options: RangeOptions): void {
  const { seed, from, to, counters } = options;
  // Counters are staged locally and published once per completed iteration.
  // The supervisor can terminate this thread in the middle of an iteration, so
  // publishing increments as they happen would leave a half-counted pair in the
  // shared totals and make the published figures off by a few.
  const work = new Int32Array(counters.length);
  work.set(counters);
  const publish = () => {
    const beat = counters[SLOT.heartbeat];
    const ticks = counters[SLOT.ticks];
    counters.set(work);
    counters[SLOT.heartbeat] = beat;
    counters[SLOT.ticks] = ticks;
  };
  const skip = options.skip ?? new Set<number>();
  const maxDivergences = options.maxDivergences ?? 20;
  const rng = new Rng(seed);

  // The generator is a pure function of the seed and the iteration index, so a
  // range that does not start at zero is reached by replaying the draws. That
  // is a few hundred nanoseconds per skipped iteration and it keeps the whole
  // sweep reproducible from a single number.
  for (let i = 0; i < from; i++) {
    genPattern(rng);
    genInput(rng);
    // The replay does no matching, so the iteration heartbeat would sit still
    // through it and the supervisor would read that as a stall. The liveness
    // tick is what it actually watches, and it moves here too.
    if ((i & 0xfff) === 0) counters[SLOT.ticks] += 1;
  }

  for (let i = from; i < to; i++) {
    counters[SLOT.heartbeat] = i;
    counters[SLOT.ticks] += 1;
    const pattern = genPattern(rng);
    const input = genInput(rng);
    if (skip.has(i)) {
      work[SLOT.oracleSkipped] += 1;
      publish();
      continue;
    }

    let ast: Node;
    let ours: Regex;
    try {
      ast = parse(pattern).ast;
      ours = new Regex(pattern);
    } catch (err) {
      if (err instanceof ProgramTooLargeError) {
        work[SLOT.skippedTooLarge] += 1;
        publish();
        continue;
      }
      if (err instanceof RegexSyntaxError) {
        // The generator only emits patterns inside the supported grammar, so a
        // syntax error here is a generator or parser bug and must surface.
        report(options, counters, {
          kind: "parse",
          iteration: i,
          pattern,
          input,
          ours: `parse error: ${err.message}`,
          theirs: "inside the generator grammar",
        });
        publish();
        if (work[SLOT.divergences] >= maxDivergences) return;
        continue;
      }
      throw err;
    }

    work[SLOT.pairs] += 1;
    // Counted per pair rather than per distinct pattern. A distinct-pattern
    // set would have to live inside this function, which restarts whenever the
    // supervisor terminates a stalled worker, so the same pattern would be
    // counted once per segment and the total would drift with the host's speed.
    // A per-pair count is a pure function of the generated pairs and answers
    // the question that matters anyway: is the sweep exercising captures.
    if (groupCount(ast) > 0) work[SLOT.pairsWithGroups] += 1;

    const theirs = new RegExp(pattern, "d");

    const oursAccepts = ours.test(input);
    const theirsAccepts = theirs.test(input);
    work[SLOT.acceptance] += 1;
    if (oursAccepts !== theirsAccepts) {
      report(options, counters, {
        kind: "acceptance",
        iteration: i,
        pattern,
        input,
        ours: String(oursAccepts),
        theirs: String(theirsAccepts),
      });
      publish();
      if (work[SLOT.divergences] >= maxDivergences) return;
      continue;
    }
    work[SLOT.acceptanceAgreed] += 1;
    if (oursAccepts) work[SLOT.matched] += 1;

    const oursMatch = ours.exec(input);
    const theirsMatch = theirs.exec(input);

    const oursWhole = oursMatch === null ? "null" : `${oursMatch.index}:${oursMatch.end}`;
    const theirsWhole =
      theirsMatch === null
        ? "null"
        : `${theirsMatch.index}:${theirsMatch.index + theirsMatch[0].length}`;
    if (oursWhole !== theirsWhole) {
      report(options, counters, {
        kind: "whole-match",
        iteration: i,
        pattern,
        input,
        ours: oursWhole,
        theirs: theirsWhole,
      });
      publish();
      if (work[SLOT.divergences] >= maxDivergences) return;
      continue;
    }
    work[SLOT.wholeMatchAgreed] += 1;

    const inSubset = isSpanComparable(ast);
    work[SLOT.spanCompared] += 1;
    if (inSubset) work[SLOT.spanSubsetCompared] += 1;
    const oursSpans = spansOf(oursMatch, ours.groupCount);
    const theirsSpans = platformSpans(theirsMatch, ours.groupCount);
    if (oursSpans === theirsSpans) {
      work[SLOT.spanAgreed] += 1;
      if (inSubset) work[SLOT.spanSubsetAgreed] += 1;
    } else {
      report(options, counters, {
        kind: "span",
        iteration: i,
        pattern,
        input,
        ours: oursSpans,
        theirs: theirsSpans,
      });
      if (work[SLOT.divergences] >= maxDivergences) {
        publish();
        return;
      }
    }
    publish();
  }
}

function report(options: RangeOptions, counters: Int32Array, d: Divergence): void {
  counters[SLOT.divergences] += 1;
  options.onDivergence?.(d);
}

export function spansOf(m: ReturnType<Regex["exec"]>, groups: number): string {
  if (m === null) return "null";
  const out: string[] = [];
  for (let g = 0; g <= groups; g++) {
    const span = m.groups[g];
    out.push(span === null ? "-" : `${span[0]}:${span[1]}`);
  }
  return out.join(" ");
}

/**
 * Exact group positions from the platform engine, via the match indices the 'd'
 * flag exposes. Comparing positions rather than text matters: two different
 * spans can hold the same characters, so a text comparison would quietly accept
 * a wrong answer.
 */
export function platformSpans(m: RegExpExecArray | null, groups: number): string {
  if (m === null) return "null";
  const indices = m.indices;
  if (indices === undefined) throw new Error("the d flag did not produce match indices");
  const out: string[] = [];
  for (let g = 0; g <= groups; g++) {
    const span = indices[g];
    out.push(span === undefined ? "-" : `${span[0]}:${span[1]}`);
  }
  return out.join(" ");
}
