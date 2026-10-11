// The part of the benchmark that CI is allowed to judge.
//
// Nothing here is a wall-clock measurement. Every number is a count of work the
// VM performed, which is identical on every machine, so a regression here is a
// real regression rather than a noisy runner. The timing table in the README is
// measured locally and is explicitly not gated; see bench/redos.ts.

import { Regex } from "../src/index.ts";
import { REDOS_CASES, buildInput, inputFor, patternFor } from "./cases.ts";

/** Patterns whose compiled size is part of the published claim. */
const PROGRAMS: readonly [string, string][] = [
  ["literal-a", "a"],
  ["star", "a*"],
  ["plus", "a+"],
  ["optional", "a?"],
  ["digits", "\\d+"],
  ["date", "(\\d{4})-(\\d{2})-(\\d{2})"],
  ["alt-nested", "^(a|aa)+$"],
  ["plus-nested", "(a+)+$"],
  ["two-plus", "(x+x+)+y"],
  ["empty-star", "(a*)*b"],
  ["counted", "a{10}"],
  ["guarded-plus", "(a?)+"],
];

/** Fixed sizes at which the structural bound is checked and published. */
const BOUND_SIZES = [0, 1, 64, 1024] as const;

interface CheckedRow {
  id: string;
  pattern: string;
  n: number;
  inputLength: number;
  progLen: number;
  adds: number;
  charSteps: number;
  maxListSize: number;
  bound: number;
  withinBound: boolean;
}

const programs: Record<string, number> = {};
for (const [id, pattern] of PROGRAMS) {
  programs[id] = new Regex(pattern).program.insts.length;
}

const rows: CheckedRow[] = [];
for (const c of REDOS_CASES) {
  for (const n of BOUND_SIZES) {
    // The counted case pins its pattern at 20 and varies only the input, so
    // that program size stays fixed across the four rows.
    const counted = c.id === "counted-optional";
    const pattern = patternFor(c, counted ? 20 : n);
    const spec = counted ? { fill: c.fill, n, suffix: c.suffix } : inputFor(c, n);
    const re = new Regex(pattern);
    const input = buildInput(spec);
    re.test(input);
    const bound = (input.length + 1) * re.program.insts.length;
    rows.push({
      id: c.id,
      pattern,
      n,
      inputLength: input.length,
      progLen: re.program.insts.length,
      adds: re.stats.addsPerformed,
      charSteps: re.stats.charSteps,
      maxListSize: re.stats.maxListSize,
      bound,
      withinBound:
        re.stats.addsPerformed <= bound &&
        re.stats.charSteps <= bound &&
        re.stats.maxListSize <= re.program.insts.length,
    });
  }
}

const violations = rows.filter((r) => !r.withinBound);

/** Flat, dotted summary of just the gated quantities. */
const gated: Record<string, number> = {};
for (const [id, len] of Object.entries(programs)) gated[`programs.${id}`] = len;
for (const r of rows) {
  gated[`adds.${r.id}.${r.n}`] = r.adds;
  gated[`maxList.${r.id}.${r.n}`] = r.maxListSize;
}
gated["boundViolations"] = violations.length;

const payload = { programs, rows, gated, boundViolations: violations.length };

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  console.log("program sizes (instructions)");
  for (const [id, len] of Object.entries(programs)) {
    console.log(`  ${id.padEnd(14)} ${String(len).padStart(6)}`);
  }
  console.log("\nstructural work bound, addsPerformed <= (inputLength + 1) * progLen");
  for (const r of rows) {
    console.log(
      `  ${r.id.padEnd(18)} n=${String(r.n).padStart(5)}  adds ${String(r.adds).padStart(8)}` +
        `  bound ${String(r.bound).padStart(8)}  maxList ${String(r.maxListSize).padStart(4)}` +
        `/${String(r.progLen).padStart(4)}  ${r.withinBound ? "ok" : "VIOLATED"}`,
    );
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} bound violation(s)`);
    process.exitCode = 1;
  } else {
    console.log(`\nall ${rows.length} rows inside the bound`);
  }
}
