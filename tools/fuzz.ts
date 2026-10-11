// Supervisor for the differential fuzz.
//
// The sweep runs in a worker thread and the supervisor watches a heartbeat in a
// SharedArrayBuffer. If the heartbeat stops moving for longer than the deadline,
// the worker is terminated and the iteration it was on is recorded as an oracle
// stall. This is not defensive programming for its own sake: the generator
// reliably finds patterns on which the platform engine does not return. On this
// machine the first one appears around iteration 24,000, and a sweep without a
// supervisor simply stops there.
//
// That is worth stating plainly, because it is the finding rather than a
// workaround. The oracle is a backtracking engine, so a fuzz that explores the
// grammar freely will wander into catastrophic territory, and the engine under
// test answers those same pairs in microseconds. The stalled pairs are written
// out to test/oracle-timeouts.json so later runs skip them deterministically
// and the agreement counts stay reproducible.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { Regex } from "../src/index.ts";
import type { Divergence } from "./fuzz-core.ts";
import { SLOT, SLOT_COUNT, pairAt } from "./fuzz-core.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "fuzz-worker.ts");
const TIMEOUTS_FILE = join(HERE, "..", "test", "oracle-timeouts.json");

export const DEFAULT_SEED = 0x5eed1234;
/** How long the oracle may spend on one pair before the worker is terminated. */
export const DEFAULT_DEADLINE_MS = 2000;

export interface OracleStall {
  iteration: number;
  pattern: string;
  input: string;
  /** How long our engine needs on the same pair, in milliseconds. */
  oursMs: number;
  oursResult: boolean;
}

export interface SweepReport {
  seed: number;
  iterations: number;
  deadlineMs: number;
  pairs: number;
  acceptance: number;
  acceptanceAgreed: number;
  wholeMatchAgreed: number;
  spanCompared: number;
  spanAgreed: number;
  spanSubsetCompared: number;
  spanSubsetAgreed: number;
  matched: number;
  patternsWithGroups: number;
  skippedTooLarge: number;
  oracleSkipped: number;
  divergences: Divergence[];
  newStalls: OracleStall[];
  elapsedMs: number;
}

interface TimeoutsFile {
  deadlineMs: number;
  note: string;
  seeds: Record<string, number[]>;
}

export function loadKnownStalls(seed: number): Set<number> {
  try {
    const file = JSON.parse(readFileSync(TIMEOUTS_FILE, "utf8")) as TimeoutsFile;
    return new Set(file.seeds[String(seed)] ?? []);
  } catch {
    return new Set();
  }
}

function saveKnownStalls(seed: number, iterations: number[], deadlineMs: number): void {
  let file: TimeoutsFile;
  try {
    file = JSON.parse(readFileSync(TIMEOUTS_FILE, "utf8")) as TimeoutsFile;
  } catch {
    file = {
      deadlineMs,
      note:
        "Pattern and input pairs, by generator seed and iteration index, on which " +
        "the platform regular expression engine did not return inside the deadline. " +
        "Found by tools/fuzz.ts, not curated by hand. Listed so that agreement " +
        "counts are reproducible; the engine under test answers all of them.",
      seeds: {},
    };
  }
  const merged = new Set([...(file.seeds[String(seed)] ?? []), ...iterations]);
  file.seeds[String(seed)] = [...merged].sort((a, b) => a - b);
  file.deadlineMs = deadlineMs;
  writeFileSync(TIMEOUTS_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

/** Times our engine on a pair the oracle could not finish. */
function measureOurs(pattern: string, input: string): { ms: number; result: boolean } {
  const re = new Regex(pattern);
  re.test(input);
  const t = performance.now();
  const result = re.test(input);
  return { ms: performance.now() - t, result };
}

export interface SweepOptions {
  seed?: number;
  iterations: number;
  deadlineMs?: number;
  maxDivergences?: number;
  /** Called with a progress line every `progressEvery` iterations. */
  progressEvery?: number;
  onProgress?: (line: string) => void;
  /** Skip the committed hostile list. Only useful when rebuilding it. */
  ignoreKnownStalls?: boolean;
}

export async function sweep(options: SweepOptions): Promise<SweepReport> {
  const seed = options.seed ?? DEFAULT_SEED;
  const iterations = options.iterations;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxDivergences = options.maxDivergences ?? 20;
  const known = options.ignoreKnownStalls ? new Set<number>() : loadKnownStalls(seed);
  const skip = new Set(known);

  const buffer = new SharedArrayBuffer(SLOT_COUNT * 4);
  const counters = new Int32Array(buffer);
  const divergences: Divergence[] = [];
  const newStalls: OracleStall[] = [];
  const started = performance.now();
  let cursor = 0;

  while (cursor < iterations) {
    const stalledAt = await runWorker({
      seed,
      from: cursor,
      to: iterations,
      buffer,
      skip: [...skip],
      maxDivergences,
      deadlineMs,
      counters,
      divergences,
      progressEvery: options.progressEvery ?? 0,
      onProgress: options.onProgress,
      started,
    });
    if (stalledAt === null) break;
    const { pattern, input } = pairAt(seed, stalledAt);
    const ours = measureOurs(pattern, input);
    newStalls.push({
      iteration: stalledAt,
      pattern,
      input,
      oursMs: ours.ms,
      oursResult: ours.result,
    });
    skip.add(stalledAt);
    counters[SLOT.oracleSkipped] += 1;
    cursor = stalledAt + 1;
  }

  return {
    seed,
    iterations,
    deadlineMs,
    pairs: counters[SLOT.pairs],
    acceptance: counters[SLOT.acceptance],
    acceptanceAgreed: counters[SLOT.acceptanceAgreed],
    wholeMatchAgreed: counters[SLOT.wholeMatchAgreed],
    spanCompared: counters[SLOT.spanCompared],
    spanAgreed: counters[SLOT.spanAgreed],
    spanSubsetCompared: counters[SLOT.spanSubsetCompared],
    spanSubsetAgreed: counters[SLOT.spanSubsetAgreed],
    matched: counters[SLOT.matched],
    patternsWithGroups: counters[SLOT.patternsWithGroups],
    skippedTooLarge: counters[SLOT.skippedTooLarge],
    oracleSkipped: counters[SLOT.oracleSkipped],
    divergences,
    newStalls,
    elapsedMs: performance.now() - started,
  };
}

interface WorkerRun {
  seed: number;
  from: number;
  to: number;
  buffer: SharedArrayBuffer;
  skip: number[];
  maxDivergences: number;
  deadlineMs: number;
  counters: Int32Array;
  divergences: Divergence[];
  progressEvery: number;
  onProgress?: (line: string) => void;
  started: number;
}

/** Resolves with the stalled iteration, or null when the range completed. */
function runWorker(run: WorkerRun): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: {
        seed: run.seed,
        from: run.from,
        to: run.to,
        buffer: run.buffer,
        skip: run.skip,
        maxDivergences: run.maxDivergences,
      },
    });
    let settled = false;
    let lastBeat = run.counters[SLOT.heartbeat];
    let lastMove = performance.now();
    let nextProgress = run.progressEvery > 0 ? run.from + run.progressEvery : Infinity;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      void worker.terminate();
      resolve(value);
    };

    const timer = setInterval(() => {
      const beat = run.counters[SLOT.heartbeat];
      if (beat !== lastBeat) {
        lastBeat = beat;
        lastMove = performance.now();
      } else if (performance.now() - lastMove > run.deadlineMs) {
        finish(beat);
        return;
      }
      if (beat >= nextProgress && run.onProgress) {
        const secs = (performance.now() - run.started) / 1000;
        run.onProgress(
          `  ${beat.toLocaleString()} pairs, ${secs.toFixed(1)} s, ` +
            `${Math.round(beat / secs).toLocaleString()} pairs/s`,
        );
        nextProgress = beat + run.progressEvery;
      }
    }, 50);

    worker.on("message", (m: { type: string; d?: Divergence }) => {
      if (m.type === "divergence" && m.d) run.divergences.push(m.d);
      if (m.type === "done") finish(null);
    });
    worker.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      reject(err);
    });
    worker.on("exit", () => {
      if (!settled && run.counters[SLOT.done] === 1) finish(null);
    });
  });
}

export function formatReport(r: SweepReport): string {
  const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(4)}%`);
  const lines = [
    `seed ${r.seed}, ${r.iterations.toLocaleString()} pairs generated in ${(r.elapsedMs / 1000).toFixed(1)} s`,
    `acceptance    ${r.acceptanceAgreed.toLocaleString()} / ${r.acceptance.toLocaleString()} agreed (${pct(r.acceptanceAgreed, r.acceptance)})`,
    `whole match   ${r.wholeMatchAgreed.toLocaleString()} spans agreed`,
    `span-exact    ${r.spanAgreed.toLocaleString()} / ${r.spanCompared.toLocaleString()} agreed (${pct(r.spanAgreed, r.spanCompared)})`,
    `  subset only ${r.spanSubsetAgreed.toLocaleString()} / ${r.spanSubsetCompared.toLocaleString()} with no capture group under a quantifier`,
    `matched       ${r.matched.toLocaleString()} pairs actually matched`,
    `patterns      ${r.patternsWithGroups.toLocaleString()} distinct patterns carrying capture groups`,
    `skipped       ${r.skippedTooLarge.toLocaleString()} past the program size ceiling`,
    `oracle stalls ${r.oracleSkipped.toLocaleString()} pairs the platform engine did not answer in ${r.deadlineMs} ms`,
  ];
  if (r.newStalls.length > 0) {
    lines.push(`\n${r.newStalls.length} newly discovered oracle stall(s):`);
    for (const s of r.newStalls) {
      lines.push(`  iteration ${s.iteration}: /${s.pattern}/ on ${JSON.stringify(s.input)}`);
      lines.push(
        `    ours answered ${s.oursResult} in ${s.oursMs.toFixed(3)} ms; ` +
          `the platform engine did not answer in ${r.deadlineMs} ms`,
      );
    }
  }
  if (r.divergences.length > 0) {
    lines.push(`\n${r.divergences.length} divergence(s):`);
    for (const d of r.divergences) {
      lines.push(`  [${d.kind}] /${d.pattern}/ on ${JSON.stringify(d.input)}`);
      lines.push(`      ours   ${d.ours}`);
      lines.push(`      theirs ${d.theirs}`);
    }
  }
  return lines.join("\n");
}

function parseArgs(argv: string[]) {
  let seed = DEFAULT_SEED;
  let iterations = 100000;
  let json = false;
  let progress = 0;
  let deadlineMs = DEFAULT_DEADLINE_MS;
  let record = false;
  let ignoreKnownStalls = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--seed") seed = Number(argv[++i]);
    else if (arg === "--iters" || arg === "--iterations") iterations = Number(argv[++i]);
    else if (arg === "--json") json = true;
    else if (arg === "--progress") progress = Number(argv[++i] ?? 100000);
    else if (arg === "--deadline") deadlineMs = Number(argv[++i]);
    else if (arg === "--record-stalls") record = true;
    else if (arg === "--ignore-known-stalls") ignoreKnownStalls = true;
  }
  return { seed, iterations, json, progress, deadlineMs, record, ignoreKnownStalls };
}

if (import.meta.filename === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const report = await sweep({
    seed: args.seed,
    iterations: args.iterations,
    deadlineMs: args.deadlineMs,
    progressEvery: args.progress,
    onProgress: (line) => process.stderr.write(`${line}\n`),
    ignoreKnownStalls: args.ignoreKnownStalls,
  });
  if (args.record && report.newStalls.length > 0) {
    saveKnownStalls(args.seed, report.newStalls.map((s) => s.iteration), args.deadlineMs);
    process.stderr.write(`recorded ${report.newStalls.length} stall(s) in ${TIMEOUTS_FILE}\n`);
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(formatReport(report));
  }
  if (report.divergences.length > 0) process.exitCode = 1;
}
