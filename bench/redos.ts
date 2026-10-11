// The ReDoS race, plus an honest look at the non-pathological case.
//
// Every number this writes to bench/results.json was measured by this script.
// The native engine is run in a child process with a hard kill at the cutoff,
// because a catastrophic RegExp call cannot be stopped any other way. A cell the
// child never finished is recorded as "killed" with the cutoff, and cells beyond
// the first kill are recorded as "extrapolated" with the growth factor fitted
// from the measured points. Nothing extrapolated is reported as measured.

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Regex } from "../src/index.ts";
import type { InputSpec } from "./cases.ts";
import { ORDINARY_CASES, REDOS_CASES, buildInput, inputFor, patternFor } from "./cases.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "native-probe.ts");

/** Hard ceiling on a single native trial. */
const CUTOFF_MS = 2000;
/** Ceiling on the whole run, checked before every child spawn. */
const TOTAL_BUDGET_MS = 420000;

const startedAt = performance.now();

type NativeCell =
  | { status: "measured"; ms: number; result: boolean }
  | { status: "killed"; cutoffMs: number }
  | { status: "extrapolated"; cutoffMs: number; estimateMs: number; growthPerStep: number }
  | { status: "skipped"; reason: string };

interface OursCell {
  ms: number;
  result: boolean;
  adds: number;
  progLen: number;
  inputLength: number;
}

interface Row {
  caseId: string;
  pattern: string;
  n: number;
  ours: OursCell;
  native: NativeCell;
}

function sysctl(name: string): string {
  try {
    return execFileSync("sysctl", ["-n", name], { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

/** Median of `repeats` timed runs, after a warm-up run. */
function timeOurs(pattern: string, spec: InputSpec, repeats = 7): OursCell {
  const re = new Regex(pattern);
  const subject = buildInput(spec);
  re.test(subject);
  const samples: number[] = [];
  for (let i = 0; i < repeats; i++) {
    const t = performance.now();
    re.test(subject);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const result = re.test(subject);
  return {
    ms: samples[Math.floor(samples.length / 2)],
    result,
    adds: re.stats.addsPerformed,
    progLen: re.program.insts.length,
    inputLength: subject.length,
  };
}

function timeNative(pattern: string, spec: InputSpec): NativeCell {
  if (performance.now() - startedAt > TOTAL_BUDGET_MS) {
    return { status: "skipped", reason: "run budget exhausted" };
  }
  const r = spawnSync(process.execPath, [PROBE, JSON.stringify({ pattern, input: spec })], {
    timeout: CUTOFF_MS,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  if (r.signal !== null || r.status !== 0 || !r.stdout) {
    return { status: "killed", cutoffMs: CUTOFF_MS };
  }
  const parsed = JSON.parse(r.stdout) as { elapsedMs: number; result: boolean };
  return { status: "measured", ms: parsed.elapsedMs, result: parsed.result };
}

/** Geometric mean growth per size step, from the measured native points. */
function fitGrowth(points: { n: number; ms: number }[]): number | null {
  const usable = points.filter((p) => p.ms > 0.05);
  if (usable.length < 3) return null;
  const ratios: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const steps = usable[i].n - usable[i - 1].n;
    if (steps <= 0) continue;
    ratios.push((usable[i].ms / usable[i - 1].ms) ** (1 / steps));
  }
  if (ratios.length === 0) return null;
  const logSum = ratios.reduce((a, r) => a + Math.log(r), 0);
  return Math.exp(logSum / ratios.length);
}

const rows: Row[] = [];
let killedCount = 0;

for (const c of REDOS_CASES) {
  let killedAt: number | null = null;
  const measured: { n: number; ms: number }[] = [];
  for (const n of c.sizes) {
    const pattern = patternFor(c, n);
    const spec = inputFor(c, n);
    const ours = timeOurs(pattern, spec);
    let native: NativeCell;
    if (killedAt === null) {
      native = timeNative(pattern, spec);
      if (native.status === "measured") {
        measured.push({ n, ms: native.ms });
      } else if (native.status === "killed") {
        killedAt = n;
        killedCount += 1;
      }
    } else {
      const growth = fitGrowth(measured);
      native =
        growth === null
          ? { status: "skipped", reason: "not enough measured points to extrapolate" }
          : {
              status: "extrapolated",
              cutoffMs: CUTOFF_MS,
              estimateMs:
                measured[measured.length - 1].ms *
                growth ** (n - measured[measured.length - 1].n),
              growthPerStep: growth,
            };
    }
    rows.push({ caseId: c.id, pattern, n, ours, native });
    process.stderr.write(
      `${c.id.padEnd(18)} n=${String(n).padStart(6)}  ours ${ours.ms.toFixed(4)} ms  native ${
        native.status === "measured" ? `${native.ms.toFixed(3)} ms` : native.status
      }\n`,
    );
  }
}

const ordinary = ORDINARY_CASES.map((c) => {
  const ours = timeOurs(c.pattern, c.input);
  const native = timeNative(c.pattern, c.input);
  const nativeMs = native.status === "measured" ? native.ms : null;
  process.stderr.write(
    `${c.id.padEnd(18)} ours ${ours.ms.toFixed(4)} ms  native ${nativeMs === null ? native.status : `${nativeMs.toFixed(4)} ms`}\n`,
  );
  return {
    caseId: c.id,
    pattern: c.pattern,
    inputLength: ours.inputLength,
    ours,
    native,
    slowdown: nativeMs !== null && nativeMs > 0 ? ours.ms / nativeMs : null,
  };
});

const results = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  hardware: {
    cpu: sysctl("machdep.cpu.brand_string"),
    memoryBytes: Number(sysctl("hw.memsize")) || null,
    platform: process.platform,
    arch: process.arch,
  },
  cutoffMs: CUTOFF_MS,
  note:
    "Wall-clock numbers are measured on the hardware named above and are not " +
    "verified in CI. CI gates the deterministic quantities only: differential " +
    "fuzz agreement, capture span agreement, program sizes and addthread counts.",
  redos: rows,
  ordinary,
  summary: {
    nativeKilledCases: killedCount,
    nativeCutoffMs: CUTOFF_MS,
    maxOursMs: Math.max(...rows.map((r) => r.ours.ms)),
    elapsedMs: performance.now() - startedAt,
  },
};

const out = join(HERE, "results.json");
writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
process.stderr.write(`\nwrote ${out} in ${((performance.now() - startedAt) / 1000).toFixed(1)} s\n`);
