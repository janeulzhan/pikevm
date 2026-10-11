// Renders the two wall-clock tables in the README from bench/results.json.
//
// These tables are timings, so benchlock does not gate them and CI never
// judges them. They are regenerated from the committed measurement rather than
// typed by hand, which is a weaker guarantee than benchlock gives the
// deterministic figures but still rules out a number that was never measured.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const README = join(ROOT, "README.md");
const RESULTS = join(ROOT, "bench", "results.json");
const SWEEP = join(ROOT, "bench", "sweep-1m.json");

interface NativeCell {
  status: "measured" | "killed" | "extrapolated" | "skipped";
  ms?: number;
  cutoffMs?: number;
  log10EstimateMs?: number;
  growthPerStep?: number;
}

interface Row {
  caseId: string;
  pattern: string;
  n: number;
  ours: { ms: number; adds: number; progLen: number; inputLength: number };
  native: NativeCell;
}

interface Results {
  generatedAt: string;
  node: string;
  hardware: { cpu: string; memoryBytes: number | null };
  cutoffMs: number;
  redosCases: { id: string; pattern: string; input: string }[];
  redos: Row[];
  ordinary: {
    caseId: string;
    pattern: string;
    inputLength: number;
    ours: { ms: number };
    native: NativeCell;
    slowdown: number | null;
  }[];
  catalogue: { pattern: string; inputLength: number; ms: number; adds: number }[];
  summary: { catalogueWorstMs: number; nativeKilledCases: number };
}

interface Sweep {
  seed: number;
  iterations: number;
  deadlineMs: number;
  acceptance: number;
  acceptanceAgreed: number;
  wholeMatchAgreed: number;
  spanCompared: number;
  spanAgreed: number;
  spanSubsetCompared: number;
  spanSubsetAgreed: number;
  matched: number;
  pairsWithGroups: number;
  oracleSkipped: number;
  divergences: unknown[];
  elapsedMs: number;
}

function ms(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`;
  if (value >= 1) return `${value.toFixed(2)} ms`;
  if (value >= 0.001) return `${value.toFixed(4)} ms`;
  return `${(value * 1000).toFixed(1)} \u00b5s`;
}

/**
 * Renders an estimate that is far past anything a clock can express. These are
 * labelled, never presented as measurements, and kept in log space because the
 * value itself does not fit in a double.
 */
function extrapolated(log10Ms: number): string {
  if (log10Ms < 3) return `extrapolated to ~${ms(10 ** log10Ms)}`;
  const log10Years = log10Ms - Math.log10(1000 * 60 * 60 * 24 * 365.25);
  if (log10Years < 1) return `extrapolated to ~${ms(10 ** log10Ms)}`;
  if (log10Years < 6) return `extrapolated to ~${(10 ** log10Years).toPrecision(2)} years`;
  return `extrapolated to ~10^${Math.round(log10Years)} years`;
}

function nativeCell(cell: NativeCell, cutoffMs: number): string {
  switch (cell.status) {
    case "measured":
      return ms(cell.ms ?? 0);
    case "killed":
      return `**> ${cutoffMs} ms**, killed`;
    case "extrapolated":
      return `**> ${cutoffMs} ms**, ${extrapolated(cell.log10EstimateMs ?? 0)}`;
    default:
      return "not run";
  }
}

/**
 * Four sizes per pattern: the two largest the native engine finished, the first
 * one it did not, and the largest overall. That is the frontier, which is the
 * only part of the sweep worth putting above the fold.
 */
function pickSizes(rows: Row[]): Row[] {
  const measured = rows.filter((r) => r.native.status === "measured");
  const firstKilled = rows.find((r) => r.native.status === "killed");
  const chosen = new Set<number>();
  for (const r of measured.slice(-2)) chosen.add(r.n);
  if (firstKilled) chosen.add(firstKilled.n);
  chosen.add(rows[rows.length - 1].n);
  return rows.filter((r) => chosen.has(r.n));
}

function redosTable(results: Results): string {
  const byCase = new Map<string, Row[]>();
  for (const r of results.redos) {
    const list = byCase.get(r.caseId) ?? [];
    list.push(r);
    byCase.set(r.caseId, list);
  }
  const lines = [
    "| pattern | input length | pikevm | native `RegExp` | threads pikevm admitted |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [caseId, rows] of byCase) {
    const picked = pickSizes(rows);
    // The counted case rebuilds its pattern for each size, so the group label
    // is the generic form rather than whichever row happens to come first.
    const generic = results.redosCases.find((c) => c.id === caseId)?.pattern ?? rows[0].pattern;
    picked.forEach((r, i) => {
      const label = i === 0 ? `\`${generic.replace(/\|/g, "\\|")}\`` : "";
      lines.push(
        `| ${label} | ${r.ours.inputLength.toLocaleString()} | ${ms(r.ours.ms)} | ` +
          `${nativeCell(r.native, results.cutoffMs)} | ${r.ours.adds.toLocaleString()} |`,
      );
    });
  }
  return lines.join("\n");
}

function ordinaryTable(results: Results): string {
  const lines = [
    "| pattern | input length | pikevm | native `RegExp` | pikevm is slower by |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const r of results.ordinary) {
    const factor =
      r.slowdown === null ? "not measured" : `${r.slowdown.toFixed(1)}x`;
    lines.push(
      `| \`${r.pattern.replace(/\|/g, "\\|")}\` | ${r.inputLength.toLocaleString()} | ` +
        `${ms(r.ours.ms)} | ${nativeCell(r.native, results.cutoffMs)} | ${factor} |`,
    );
  }
  return lines.join("\n");
}

function catalogueTable(results: Results): string {
  const lines = [
    "| pattern | input length | pikevm | threads admitted |",
    "| --- | ---: | ---: | ---: |",
  ];
  for (const c of results.catalogue) {
    lines.push(
      `| \`${c.pattern.replace(/\|/g, "\\|")}\` | ${c.inputLength.toLocaleString()} | ` +
        `${ms(c.ms)} | ${c.adds.toLocaleString()} |`,
    );
  }
  return lines.join("\n");
}

function sweepBlock(sweep: Sweep): string {
  const n = (v: number) => v.toLocaleString();
  const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(4)}%`);
  return [
    "| comparison | pairs compared | pairs that agreed | share |",
    "| --- | ---: | ---: | ---: |",
    `| acceptance, \`test()\` against \`RegExp.prototype.test\` | ${n(sweep.acceptance)} | ${n(sweep.acceptanceAgreed)} | ${pct(sweep.acceptanceAgreed, sweep.acceptance)} |`,
    `| whole match span | ${n(sweep.acceptanceAgreed)} | ${n(sweep.wholeMatchAgreed)} | ${pct(sweep.wholeMatchAgreed, sweep.acceptanceAgreed)} |`,
    `| every capture group span | ${n(sweep.spanCompared)} | ${n(sweep.spanAgreed)} | ${pct(sweep.spanAgreed, sweep.spanCompared)} |`,
    `| the same, restricted to the conservative subset | ${n(sweep.spanSubsetCompared)} | ${n(sweep.spanSubsetAgreed)} | ${pct(sweep.spanSubsetAgreed, sweep.spanSubsetCompared)} |`,
    "",
    `Of the ${n(sweep.iterations)} pairs generated, ${n(sweep.matched)} actually matched, and ` +
      `${n(sweep.pairsWithGroups)} of them used a pattern carrying a capture group. ` +
      `${n(sweep.oracleSkipped)} pairs are excluded from every count above, because the platform ` +
      `engine does not return on them inside the ${sweep.deadlineMs} ms deadline; they are listed in ` +
      "[`test/oracle-timeouts.json`](test/oracle-timeouts.json) and discussed below. " +
      `The sweep took ${(sweep.elapsedMs / 1000).toFixed(0)} seconds and found ` +
      `${sweep.divergences.length} disagreement${sweep.divergences.length === 1 ? "" : "s"}.`,
    "",
    "**These pair counts move by a few between machines, and that is expected.** How many pairs " +
      "get compared depends on how many the oracle fails to answer inside the deadline, and that " +
      "depends on how fast the host is: a slower machine stalls on one or two more and compares " +
      "one or two fewer. Rerunning this on your hardware should not reproduce the totals to the " +
      "digit. What is being claimed is not a pair count, it is the right-hand column: zero " +
      "disagreements, on every pair that both engines answered. That is the invariant, it does " +
      "not depend on the host, and it is what CI asserts.",
  ].join("\n");
}

function provenance(results: Results): string {
  const gib = results.hardware.memoryBytes
    ? `, ${Math.round(results.hardware.memoryBytes / 1024 ** 3)} GiB`
    : "";
  return (
    `Measured on ${results.hardware.cpu}${gib}, Node ${results.node}, ` +
    `${results.generatedAt.slice(0, 10)}. The native engine is run in a child process and killed at ` +
    `${results.cutoffMs} ms, because a catastrophic \`RegExp\` call cannot be interrupted any other way.`
  );
}

function replaceBlock(text: string, name: string, body: string): string {
  const open = `<!-- table:${name} -->`;
  const close = `<!-- /table:${name} -->`;
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`README is missing the ${open} ... ${close} block`);
  }
  return `${text.slice(0, start + open.length)}\n${body}\n${text.slice(end)}`;
}

const results = JSON.parse(readFileSync(RESULTS, "utf8")) as Results;
let text = readFileSync(README, "utf8");
const sweep = JSON.parse(readFileSync(SWEEP, "utf8")) as Sweep;
text = replaceBlock(text, "redos", redosTable(results));
text = replaceBlock(text, "catalogue", catalogueTable(results));
text = replaceBlock(text, "ordinary", ordinaryTable(results));
text = replaceBlock(text, "sweep", sweepBlock(sweep));
text = replaceBlock(text, "provenance", provenance(results));
writeFileSync(README, text);
console.log("sync-readme: regenerated the redos, catalogue, ordinary, sweep and provenance blocks");
