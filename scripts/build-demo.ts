// Bundles the demo into a single self-contained docs/index.html.
//
// The published page carries no external requests at all: the engine is inlined
// as an IIFE and the committed benchmark is inlined as a JSON literal. That
// matters for the second reason too, which is that the README table and the
// demo read the same bench/results.json, so a published number cannot drift
// away from the measured one without both of them changing together.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ESBUILD = join(ROOT, "node_modules", ".bin", "esbuild");

const bundle = execFileSync(
  ESBUILD,
  [join(ROOT, "docs", "demo.ts"), "--bundle", "--format=iife", "--minify", "--target=es2022"],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);

const resultsPath = join(ROOT, "bench", "results.json");
const resultsLiteral = existsSync(resultsPath)
  ? `window.PIKEVM_RESULTS=${readFileSync(resultsPath, "utf8").trim()};`
  : "window.PIKEVM_RESULTS=void 0;";

const template = readFileSync(join(ROOT, "docs", "template.html"), "utf8");
const html = template.replace("__RESULTS__", () => resultsLiteral).replace("__BUNDLE__", () => bundle);

const out = join(ROOT, "docs", "index.html");
writeFileSync(out, html);
console.log(`built ${out}, ${(html.length / 1024).toFixed(1)} KiB, bundle ${(bundle.length / 1024).toFixed(1)} KiB`);
