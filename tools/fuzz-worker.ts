// Worker side of the supervised sweep. Everything interesting happens in
// fuzz-core; this file exists so the supervisor has something it can terminate.

import { parentPort, workerData } from "node:worker_threads";
import { SLOT, runRange } from "./fuzz-core.ts";

const data = workerData as {
  seed: number;
  from: number;
  to: number;
  buffer: SharedArrayBuffer;
  skip: number[];
  maxDivergences: number;
};

const counters = new Int32Array(data.buffer);
runRange({
  seed: data.seed,
  from: data.from,
  to: data.to,
  counters,
  skip: new Set(data.skip),
  maxDivergences: data.maxDivergences,
  onDivergence: (d) => parentPort?.postMessage({ type: "divergence", d }),
});
counters[SLOT.done] = 1;
parentPort?.postMessage({ type: "done" });
