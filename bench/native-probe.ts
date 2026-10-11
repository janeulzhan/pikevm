// One native engine trial, run as a child process.
//
// A catastrophic RegExp call cannot be interrupted from inside the process that
// made it: there is no preemption point, so a deadline check in the same thread
// never gets a turn. Running the trial in a child and letting the parent kill it
// is the only honest way to put a ceiling on it. The parent uses the `timeout`
// option of spawnSync, which Node implements itself, so this works on a machine
// with no `timeout` binary.

import { buildInput } from "./cases.ts";

const spec = JSON.parse(process.argv[2]) as {
  pattern: string;
  input: { fill: string; n: number; suffix: string };
};

const subject = buildInput(spec.input);
const re = new RegExp(spec.pattern);
const start = performance.now();
const result = re.test(subject);
const elapsedMs = performance.now() - start;
process.stdout.write(JSON.stringify({ elapsedMs, result, length: subject.length }));
