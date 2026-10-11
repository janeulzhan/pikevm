// The demo page. Imports the real engine, no shortcuts and no second
// implementation: what runs here is the same code the tests and the benchmark
// run.

import { Regex, RegexSyntaxError, disassemble, formatInst } from "../src/index.ts";

declare global {
  interface Window {
    PIKEVM_RESULTS?: BenchResults;
  }
}

interface BenchResults {
  generatedAt: string;
  node: string;
  hardware: { cpu: string; memoryBytes: number | null };
  cutoffMs: number;
  redos: {
    caseId: string;
    pattern: string;
    n: number;
    ours: { ms: number; adds: number; progLen: number; inputLength: number };
    native: { status: string; ms?: number; cutoffMs?: number; estimateMs?: number };
  }[];
}

const results = window.PIKEVM_RESULTS;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------- the race

interface RaceCase {
  label: string;
  pattern: (n: number) => string;
  input: (n: number) => string;
}

const RACE_CASES: RaceCase[] = [
  { label: "^(a|aa)+$  on  \"a\" x n + \"b\"", pattern: () => "^(a|aa)+$", input: (n) => `${"a".repeat(n)}b` },
  { label: "(a+)+$  on  \"a\" x n + \"!\"", pattern: () => "(a+)+$", input: (n) => `${"a".repeat(n)}!` },
  { label: "(x+x+)+y  on  \"x\" x n", pattern: () => "(x+x+)+y", input: (n) => "x".repeat(n) },
  { label: "^(a?){n}a{n}$  on  \"a\" x (n-1)", pattern: (n) => `^(a?){${n}}a{${n}}$`, input: (n) => "a".repeat(n - 1) },
];

/** The native engine, run where it can be stopped. */
const WORKER_SOURCE = `
self.onmessage = (e) => {
  const { pattern, input } = e.data;
  const started = performance.now();
  let result;
  try {
    result = new RegExp(pattern).test(input);
  } catch (err) {
    self.postMessage({ error: String(err) });
    return;
  }
  self.postMessage({ elapsedMs: performance.now() - started, result });
};
`;

const NATIVE_DEADLINE_MS = 2000;

function raceNative(pattern: string, input: string): Promise<{ elapsedMs: number; result: boolean } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const worker = new Worker(url);
    let settled = false;
    const done = (value: { elapsedMs: number; result: boolean } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), NATIVE_DEADLINE_MS);
    worker.onmessage = (e) => done(e.data.error ? null : e.data);
    worker.onerror = () => done(null);
    worker.postMessage({ pattern, input });
  });
}

function setTimer(el: HTMLElement, value: string, note: string, running: boolean): void {
  el.classList.toggle("running", running);
  (el.querySelector(".val") as HTMLElement).textContent = value;
  (el.querySelector(".note") as HTMLElement).textContent = note;
}

function initRace(): void {
  const select = $<HTMLSelectElement>("race-pattern");
  RACE_CASES.forEach((c, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = c.label;
    select.append(opt);
  });

  const slider = $<HTMLInputElement>("race-n");
  const subject = $("race-subject");
  const go = $<HTMLButtonElement>("race-go");
  const oursTimer = $("timer-ours");
  const theirsTimer = $("timer-theirs");
  const history = $("race-history").querySelector("tbody") as HTMLElement;

  const describe = () => {
    const c = RACE_CASES[Number(select.value)];
    const n = Number(slider.value);
    subject.textContent = `n = ${n}, pattern /${c.pattern(n)}/, subject length ${c.input(n).length}`;
  };
  select.addEventListener("change", describe);
  slider.addEventListener("input", describe);
  describe();

  const race = async () => {
    const c = RACE_CASES[Number(select.value)];
    const n = Number(slider.value);
    const pattern = c.pattern(n);
    const input = c.input(n);

    go.disabled = true;
    setTimer(oursTimer, "running", "", true);
    setTimer(theirsTimer, "running", "worker started", true);

    const re = new Regex(pattern);
    re.test(input);
    const t0 = performance.now();
    const oursResult = re.test(input);
    const oursMs = performance.now() - t0;
    const adds = re.stats.addsPerformed;
    setTimer(
      oursTimer,
      `${oursMs.toFixed(3)} ms`,
      `answered ${oursResult}, ${adds.toLocaleString()} threads admitted across ${(input.length + 1).toLocaleString()} positions`,
      false,
    );

    const native = await raceNative(pattern, input);
    if (native === null) {
      setTimer(
        theirsTimer,
        `> ${NATIVE_DEADLINE_MS} ms`,
        `no answer, worker killed at the ${NATIVE_DEADLINE_MS} ms deadline`,
        false,
      );
    } else {
      setTimer(theirsTimer, `${native.elapsedMs.toFixed(3)} ms`, `answered ${native.result}`, false);
    }

    const row = document.createElement("tr");
    row.innerHTML =
      `<td class="num">${n}</td>` +
      `<td class="num">${oursMs.toFixed(3)} ms</td>` +
      `<td class="num">${native === null ? `&gt; ${NATIVE_DEADLINE_MS} ms` : `${native.elapsedMs.toFixed(3)} ms`}</td>` +
      `<td class="num">${adds.toLocaleString()}</td>`;
    history.prepend(row);
    while (history.children.length > 8) history.lastElementChild?.remove();

    go.disabled = false;
  };

  go.addEventListener("click", () => void race());
  // Run once on arrival. The interesting state of this page is the result, not
  // the empty form, and the native engine runs in a worker so the two seconds
  // it spends failing do not block anything.
  void race();
}

// ------------------------------------------------------- the thread set

interface VisState {
  trace: number[][];
  progLen: number;
  frame: number;
  raf: number;
}

let vis: VisState | null = null;
const CANVAS_WIDTH = 1600;

function drawThreads(canvas: HTMLCanvasElement, state: VisState): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const styles = getComputedStyle(document.documentElement);
  const grid = styles.getPropertyValue("--grid").trim() || "#eee";
  const dot = styles.getPropertyValue("--dot").trim() || "#1a7f5a";
  const line = styles.getPropertyValue("--line").trim() || "#ddd";

  const cols = Math.max(state.trace.length, 1);
  const rows = Math.max(state.progLen, 1);
  const pad = 16;
  // Square cells, capped so a short pattern does not turn into a few enormous
  // blocks, and the whole grid centred in a fixed-width backing store.
  const cell = Math.max(Math.min((CANVAS_WIDTH - pad * 2) / cols, 40), 2.5);
  canvas.width = CANVAS_WIDTH;
  canvas.height = Math.round(rows * cell + pad * 2);
  const ox = (CANVAS_WIDTH - cols * cell) / 2;
  const oy = pad;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = grid;
  const inset = cell * 0.17;
  const side = Math.max(cell - inset * 2, 1);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) {
      ctx.fillRect(ox + x * cell + inset, oy + y * cell + inset, side, side);
    }
  }

  ctx.fillStyle = dot;
  const r = Math.max(cell * 0.3, 1.2);
  const shown = Math.min(state.frame, cols);
  for (let x = 0; x < shown; x++) {
    for (const pc of state.trace[x]) {
      ctx.beginPath();
      ctx.arc(ox + x * cell + cell / 2, oy + pc * cell + cell / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (shown < cols) {
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    const sweep = ox + shown * cell;
    ctx.beginPath();
    ctx.moveTo(sweep, oy - pad * 0.5);
    ctx.lineTo(sweep, canvas.height - oy + pad * 0.5);
    ctx.stroke();
  }
}

function runVis(): void {
  const canvas = $<HTMLCanvasElement>("vis-canvas");
  const err = $("vis-error");
  const stats = $("vis-stats");
  err.textContent = "";
  if (vis) cancelAnimationFrame(vis.raf);

  const pattern = $<HTMLInputElement>("vis-pattern").value;
  const input = $<HTMLInputElement>("vis-input").value;
  let re: Regex;
  try {
    re = new Regex(pattern);
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  const matched = re.run(input, { captures: false, trace: true }) !== null;
  const trace = re.trace;
  const progLen = re.program.insts.length;
  const widest = trace.reduce((a, col) => Math.max(a, col.length), 0);
  const bound = (input.length + 1) * progLen;

  stats.textContent =
    `${matched ? "matched" : "no match"}; ${progLen} instructions, ${input.length + 1} positions, ` +
    `${re.stats.addsPerformed.toLocaleString()} threads admitted out of a ${bound.toLocaleString()} ceiling; ` +
    `widest column held ${widest} of ${progLen} possible`;

  const state: VisState = { trace, progLen, frame: 0, raf: 0 };
  vis = state;
  const step = () => {
    drawThreads(canvas, state);
    if (state.frame <= trace.length) {
      state.frame += 1;
      state.raf = requestAnimationFrame(step);
    }
  };
  step();
}

// -------------------------------------------------------------- try it

function runTryIt(): void {
  const groupsEl = $("try-groups");
  const err = $("try-error");
  const prog = $("try-program");
  const pattern = $<HTMLInputElement>("try-pattern").value;
  const input = $<HTMLInputElement>("try-input").value;
  err.textContent = "";
  groupsEl.textContent = "";
  prog.textContent = "";

  let re: Regex;
  try {
    re = new Regex(pattern);
  } catch (e) {
    err.textContent =
      e instanceof RegexSyntaxError ? e.message : e instanceof Error ? e.message : String(e);
    return;
  }
  prog.textContent = disassemble(re.program);

  const m = re.exec(input);
  if (m === null) {
    const row = document.createElement("div");
    row.className = "group-row";
    row.innerHTML = '<span class="gname">result</span><span class="gtext unset">no match</span>';
    groupsEl.append(row);
    return;
  }
  m.groups.forEach((span, i) => {
    const row = document.createElement("div");
    row.className = "group-row";
    const name = i === 0 ? "whole" : `group ${i}`;
    const where = span === null ? "unset" : `${span[0]}..${span[1]}`;
    const text = m.slices[i];
    row.innerHTML =
      `<span class="gname">${name}</span>` +
      `<span class="gspan">${where}</span>` +
      (text === null
        ? '<span class="gtext unset">did not participate</span>'
        : `<span class="gtext">${escapeHtml(JSON.stringify(text))}</span>`);
    groupsEl.append(row);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

// ----------------------------------------------------------- provenance

function initProvenance(): void {
  const el = $("provenance");
  if (!results) {
    el.textContent =
      "Benchmark provenance was not inlined into this build. The timings above were measured live in your browser.";
    return;
  }
  const killed = results.redos.filter((r) => r.native.status === "killed").length;
  const gib = results.hardware.memoryBytes
    ? ` with ${Math.round(results.hardware.memoryBytes / 1024 ** 3)} GiB of memory`
    : "";
  el.textContent =
    `The committed benchmark in bench/results.json was measured on ${results.hardware.cpu}${gib} ` +
    `under Node ${results.node} on ${results.generatedAt.slice(0, 10)}, with the native engine killed ` +
    `at ${results.cutoffMs} ms. ${killed} of ${results.redos.length} rows reached that ceiling. ` +
    `The numbers you produce on this page are measured in your browser and will differ.`;
}

// -------------------------------------------------------------- startup

initRace();
initProvenance();
$("vis-go").addEventListener("click", runVis);
$<HTMLInputElement>("vis-pattern").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") runVis();
});
$<HTMLInputElement>("vis-input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") runVis();
});
runVis();

for (const id of ["try-pattern", "try-input"]) {
  $<HTMLInputElement>(id).addEventListener("input", runTryIt);
}
runTryIt();

// Keep the visualiser legible when the colour scheme flips mid-session.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (vis) drawThreads($<HTMLCanvasElement>("vis-canvas"), vis);
});

void formatInst;
