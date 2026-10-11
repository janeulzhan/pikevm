// Deterministic generator for the differential fuzz, plus the predicate that
// decides when capture positions are safe to compare against the platform
// engine.

import type { Node } from "../src/ast.ts";
import { walk } from "../src/ast.ts";

/** Mulberry32. Thirty two bits of state, fast, and identical on every host. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  /** Inclusive range. */
  between(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// A small alphabet keeps the match rate high, which is the whole point: a fuzz
// where almost nothing matches tests almost nothing.
const LITERALS = ["a", "b", "c", "0", "1", "_", "-", " ", "x"] as const;
const INPUT_ALPHABET = ["a", "b", "c", "0", "1", "_", "-", " ", "x", "\n"] as const;
const SHORTHANDS = ["\\d", "\\w", "\\s", "\\D", "\\W", "\\S"] as const;
const CLASS_BODIES = [
  "[abc]",
  "[a-c]",
  "[^a]",
  "[^a-c]",
  "[a-c0-1]",
  "[\\d_]",
  "[\\w-]",
  "[-a]",
  "[a-]",
  "[^\\d]",
  "[ab0]",
] as const;

/**
 * Emits a pattern inside the language both engines agree on. Excluded by
 * construction: backreferences, lookaround, word boundaries, a bare '{' (which
 * JavaScript's Annex B grammar treats as a literal and this parser rejects),
 * and quantified bare anchors (likewise rejected here). Nothing is excluded
 * because it is hard to match, only because the two grammars differ on it.
 */
export function genPattern(rng: Rng, depth = 0): string {
  return alt(rng, depth);
}

function alt(rng: Rng, depth: number): string {
  const count = depth >= 3 ? 1 : rng.between(1, 3);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) parts.push(concat(rng, depth));
  return parts.join("|");
}

function concat(rng: Rng, depth: number): string {
  const count = depth >= 3 ? rng.between(1, 2) : rng.between(1, 3);
  let out = "";
  for (let i = 0; i < count; i++) out += rep(rng, depth);
  return out;
}

function rep(rng: Rng, depth: number): string {
  const { text, quantifiable } = atom(rng, depth);
  if (!quantifiable || !rng.chance(0.45)) return text;
  const form = rng.int(6);
  switch (form) {
    case 0:
      return `${text}*`;
    case 1:
      return `${text}+`;
    case 2:
      return `${text}?`;
    case 3:
      return `${text}{${rng.between(0, 3)}}`;
    case 4:
      return `${text}{${rng.between(0, 2)},}`;
    default: {
      const lo = rng.between(0, 2);
      return `${text}{${lo},${lo + rng.between(0, 2)}}`;
    }
  }
}

function atom(rng: Rng, depth: number): { text: string; quantifiable: boolean } {
  const roll = rng.float();
  if (depth < 3 && roll < 0.14) {
    return { text: `(${alt(rng, depth + 1)})`, quantifiable: true };
  }
  if (depth < 3 && roll < 0.22) {
    return { text: `(?:${alt(rng, depth + 1)})`, quantifiable: true };
  }
  if (roll < 0.3) return { text: rng.pick(CLASS_BODIES), quantifiable: true };
  if (roll < 0.36) return { text: ".", quantifiable: true };
  if (roll < 0.44) return { text: rng.pick(SHORTHANDS), quantifiable: true };
  if (roll < 0.47) return { text: "^", quantifiable: false };
  if (roll < 0.5) return { text: "$", quantifiable: false };
  if (roll < 0.53) return { text: rng.pick(["\\.", "\\*", "\\(", "\\|", "\\\\"]), quantifiable: true };
  return { text: rng.pick(LITERALS), quantifiable: true };
}

export function genInput(rng: Rng, maxLength = 20): string {
  const n = rng.int(maxLength + 1);
  let out = "";
  for (let i = 0; i < n; i++) out += rng.pick(INPUT_ALPHABET);
  return out;
}

/**
 * True when capture positions may be compared against the platform engine.
 *
 * The two engines share leftmost-first preference, so acceptance and the whole
 * match span agree everywhere. Group positions are a different matter. The
 * ECMAScript RepeatMatcher clears the capture slots of every group inside a
 * quantifier at the start of each iteration, so /(?:(a)|b)+/ on "ab" leaves
 * group one undefined in the platform engine while a Pike VM, which never
 * rewinds, still holds the "a" from the first iteration. That reset is a
 * backtracking artefact, not an ambiguity, and reproducing it would mean
 * tracking per-iteration slot ranges. Patterns with a capture group under a
 * quantifier are therefore excluded from the span comparison and counted
 * separately, which is why the README reports two numbers.
 */
export function isSpanComparable(ast: Node): boolean {
  return !hasGroupUnderRepeat(ast, false);
}

function hasGroupUnderRepeat(node: Node, inRepeat: boolean): boolean {
  if (inRepeat && node.kind === "group") return true;
  switch (node.kind) {
    case "concat":
      return node.parts.some((p) => hasGroupUnderRepeat(p, inRepeat));
    case "alt":
      return node.options.some((o) => hasGroupUnderRepeat(o, inRepeat));
    case "repeat":
      return hasGroupUnderRepeat(node.body, true);
    case "group":
    case "noncap":
      return hasGroupUnderRepeat(node.body, inRepeat);
    default:
      return false;
  }
}

/** Number of capture groups, used only for reporting. */
export function groupCount(ast: Node): number {
  let n = 0;
  walk(ast, (x) => {
    if (x.kind === "group") n += 1;
  });
  return n;
}
