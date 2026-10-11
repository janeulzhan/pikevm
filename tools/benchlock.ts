// benchlock keeps the numbers written in the README tied to the numbers the
// tools actually produce.
//
// Every published figure sits inside a marker span:
//
//     <!--bench:fuzz.acceptanceAgreed-->24,999<!--/bench-->
//
// Running `npm run benchlock` recomputes the metrics and rewrites the spans.
// Running `npm run benchlock:check` recomputes them and exits non-zero if a
// committed figure has drifted past the tolerance declared for its key. CI runs
// the check, so a number in the README cannot quietly stop being true.
//
// Only deterministic quantities are gated: differential fuzz agreement counts,
// capture span agreement counts, compiled program sizes and addthread counts.
// Wall-clock timings are not gated and never will be, because a shared CI
// runner cannot measure them. Those live in a separate README table, labelled
// with the hardware they were measured on.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const README = join(ROOT, "README.md");

/** Iterations in the gated sweep. Matches the sweep in test/fuzz.test.ts. */
export const GATED_FUZZ_ITERATIONS = 25000;

export class MalformedMarkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedMarkerError";
  }
}

export class UnknownMetricError extends Error {
  constructor(key: string) {
    super(`README marker refers to unknown metric "${key}"`);
    this.name = "UnknownMetricError";
  }
}

export interface Tolerance {
  /** Absolute allowance, in the metric's own units. */
  abs?: number;
  /** Relative allowance, as a fraction of the fresh value. */
  rel?: number;
}

/**
 * Tolerances by key prefix, longest prefix wins. Zero means exact.
 *
 * The agreement counts carry a small relative allowance for one reason only:
 * a pair the platform engine cannot finish inside the deadline is skipped, and
 * which pairs those are depends on how fast the machine is. The count of
 * disagreements carries no allowance at all, because that is the actual claim.
 */
export const TOLERANCES: Record<string, Tolerance> = {
  "": { abs: 0 },
  "fuzz.divergenceCount": { abs: 0 },
  "fuzz.iterations": { abs: 0 },
  "fuzz.acceptance": { rel: 0.002 },
  "fuzz.acceptanceAgreed": { rel: 0.002 },
  "fuzz.spanCompared": { rel: 0.002 },
  "fuzz.spanAgreed": { rel: 0.002 },
  "fuzz.spanSubsetCompared": { rel: 0.002 },
  "fuzz.spanSubsetAgreed": { rel: 0.002 },
  "fuzz.wholeMatchAgreed": { rel: 0.002 },
  "fuzz.matched": { rel: 0.002 },
  "fuzz.pairsWithGroups": { rel: 0.002 },
  "fuzz.oracleSkipped": { abs: 8 },
};

export function toleranceFor(key: string): Tolerance {
  let best = "";
  for (const prefix of Object.keys(TOLERANCES)) {
    if (prefix !== "" && key.startsWith(prefix) && prefix.length > best.length) best = prefix;
  }
  return TOLERANCES[best];
}

/** Flattens a nested object into dotted keys, keeping only finite numbers. */
export function flatten(value: unknown, prefix = ""): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "number") {
      if (Number.isFinite(node)) out[path] = node;
      return;
    }
    if (typeof node === "boolean") {
      out[path] = node ? 1 : 0;
      return;
    }
    if (Array.isArray(node)) {
      out[`${path}.length`] = node.length;
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path === "" ? k : `${path}.${k}`);
    }
  };
  walk(value, prefix);
  return out;
}

export interface Marker {
  key: string;
  /** The text between the markers, as committed. */
  raw: string;
  /** Index of the first character of the opening comment. */
  start: number;
  /** Index just past the closing comment. */
  end: number;
}

const OPEN = "<!--bench:";
const CLOSE = "<!--/bench-->";

export function findMarkers(text: string): Marker[] {
  const markers: Marker[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(OPEN, cursor);
    if (start < 0) break;
    const keyEnd = text.indexOf("-->", start);
    if (keyEnd < 0) {
      throw new MalformedMarkerError(`unterminated opening marker at offset ${start}`);
    }
    const key = text.slice(start + OPEN.length, keyEnd).trim();
    if (key === "") {
      throw new MalformedMarkerError(`empty metric key at offset ${start}`);
    }
    const valueStart = keyEnd + 3;
    const close = text.indexOf(CLOSE, valueStart);
    if (close < 0) {
      throw new MalformedMarkerError(`marker "${key}" at offset ${start} has no ${CLOSE}`);
    }
    const nextOpen = text.indexOf(OPEN, valueStart);
    if (nextOpen >= 0 && nextOpen < close) {
      throw new MalformedMarkerError(
        `marker "${key}" at offset ${start} is not closed before the next marker begins`,
      );
    }
    markers.push({
      key,
      raw: text.slice(valueStart, close),
      start,
      end: close + CLOSE.length,
    });
    cursor = close + CLOSE.length;
  }
  const stray = text.indexOf(CLOSE);
  if (stray >= 0 && !markers.some((m) => m.end === stray + CLOSE.length)) {
    throw new MalformedMarkerError(`closing marker at offset ${stray} has no opening marker`);
  }
  return markers;
}

/** Parses a committed value, tolerating thousands separators. */
export function parseCommitted(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new MalformedMarkerError(`committed value ${JSON.stringify(raw)} is not a number`);
  }
  return n;
}

export function formatValue(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(3);
}

export function rewrite(text: string, metrics: Record<string, number>): string {
  const markers = findMarkers(text);
  let out = "";
  let cursor = 0;
  for (const m of markers) {
    if (!(m.key in metrics)) throw new UnknownMetricError(m.key);
    out += text.slice(cursor, m.start);
    out += `${OPEN}${m.key}-->${formatValue(metrics[m.key])}${CLOSE}`;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

export class UnknownFlagError extends Error {
  constructor(flag: string) {
    super(
      `unknown flag ${JSON.stringify(flag)}. ` +
        `benchlock accepts only ${[...KNOWN_FLAGS].sort().join(", ")}`,
    );
    this.name = "UnknownFlagError";
  }
}

/** Every flag the CLI understands. Anything else is refused. */
export const KNOWN_FLAGS: ReadonlySet<string> = new Set(["--check", "--json"]);

export interface ParsedArgs {
  check: boolean;
  json: boolean;
}

/**
 * Parses the command line, refusing anything unrecognised.
 *
 * This matters more than it looks. The default mode of this tool rewrites
 * README.md, and the --check mode is what CI relies on to catch drift. A typo
 * in the flag used to fall through to the write path, so `benchlock --heck`
 * would silently rewrite the very artefact it is supposed to be guarding and
 * report success. A gate that edits its subject when misused is not a gate.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  for (const arg of argv) {
    if (!KNOWN_FLAGS.has(arg)) throw new UnknownFlagError(arg);
  }
  return { check: argv.includes("--check"), json: argv.includes("--json") };
}

export interface Drift {
  key: string;
  committed: number;
  fresh: number;
  allowed: number;
  delta: number;
}

export function check(text: string, metrics: Record<string, number>): Drift[] {
  const drifts: Drift[] = [];
  for (const m of findMarkers(text)) {
    if (!(m.key in metrics)) throw new UnknownMetricError(m.key);
    const committed = parseCommitted(m.raw);
    const fresh = metrics[m.key];
    const tol = toleranceFor(m.key);
    const allowed = Math.max(tol.abs ?? 0, (tol.rel ?? 0) * Math.abs(fresh));
    const delta = Math.abs(fresh - committed);
    if (delta > allowed) drifts.push({ key: m.key, committed, fresh, allowed, delta });
  }
  return drifts;
}

/** Runs the measurement tools and returns the flattened, gated metrics. */
export function collect(): Record<string, number> {
  const fuzzJson = execFileSync(
    process.execPath,
    [join(ROOT, "tools", "fuzz.ts"), "--iters", String(GATED_FUZZ_ITERATIONS), "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const fuzz = JSON.parse(fuzzJson) as Record<string, unknown> & { divergences: unknown[] };
  const ciJson = execFileSync(process.execPath, [join(ROOT, "bench", "ci.ts"), "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ci = JSON.parse(ciJson) as { gated: Record<string, number> };

  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries(flatten(fuzz, "fuzz"))) metrics[k] = v;
  metrics["fuzz.divergenceCount"] = fuzz.divergences.length;
  for (const [k, v] of Object.entries(ci.gated)) metrics[`vm.${k}`] = v;
  return metrics;
}

if (import.meta.filename === process.argv[1]) {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`benchlock: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const checkOnly = args.check;
  const asJson = args.json;
  const metrics = collect();

  if (asJson) {
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
  } else if (checkOnly) {
    const text = readFileSync(README, "utf8");
    const drifts = check(text, metrics);
    const markerCount = findMarkers(text).length;
    if (drifts.length === 0) {
      console.log(`benchlock: ${markerCount} published figures still match the tools`);
    } else {
      console.error(`benchlock: ${drifts.length} of ${markerCount} published figures have drifted`);
      for (const d of drifts) {
        console.error(
          `  ${d.key}: README says ${formatValue(d.committed)}, tools say ${formatValue(d.fresh)} ` +
            `(off by ${formatValue(d.delta)}, allowed ${formatValue(d.allowed)})`,
        );
      }
      console.error("\nrun `npm run benchlock` to update the README, then review the diff");
      process.exitCode = 1;
    }
  } else {
    const text = readFileSync(README, "utf8");
    const next = rewrite(text, metrics);
    writeFileSync(README, next);
    const markerCount = findMarkers(next).length;
    console.log(`benchlock: refreshed ${markerCount} published figures in README.md`);
  }
}
